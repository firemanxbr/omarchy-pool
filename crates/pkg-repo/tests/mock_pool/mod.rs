//! The pool and the upstream on a local port that the pool jobs' tests talk to (`serve`): a
//! request's head as a handler sees it, the body left on the connection for the handler to read
//! as it comes, and an answer. Shared by `pool_memory.rs` (a sync's and a render's memory) and
//! `shared_any.rs` (#421: the same bytes in both architectures' repositories); each test crate
//! uses part of it.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

/// A request as a handler sees it; the handler reads the body from the connection itself, so a
/// part is hashed as it comes in, never held.
pub struct Head {
    pub method: String,
    pub target: String,
    pub len: u64,
}

impl Head {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    pub fn query(&self, key: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        q.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            (k == key).then(|| decode(v))
        })
    }
}

/// `%XX` and `+` of a query value.
pub fn decode(v: &str) -> String {
    let b = v.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(&v[i + 1..i + 3], 16).unwrap());
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap()
}

/// What a handler answers: a status and a body, or a file streamed from disk.
pub enum Answer {
    Body(u16, Vec<u8>),
    File(PathBuf),
}

pub fn answer(status: u16, v: &Value) -> Answer {
    Answer::Body(status, v.to_string().into_bytes())
}

pub type Handler = dyn Fn(&Head, &mut dyn Read) -> Answer + Send + Sync;

/// An HTTP/1.1 server on a local port, a thread per connection, each answered and closed.
pub fn serve(handler: Arc<Handler>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = Arc::clone(&handler);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let mut words = line.split_whitespace();
                let method = words.next().unwrap_or_default().to_owned();
                let target = words.next().unwrap_or_default().to_owned();
                let mut len = 0u64;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                    assert!(
                        !lower.starts_with("transfer-encoding"),
                        "every body says its length: {h}"
                    );
                }
                let head = Head {
                    method,
                    target,
                    len,
                };
                let mut body = (&mut reader).take(len);
                let out = handler(&head, &mut body);
                std::io::copy(&mut body, &mut std::io::sink()).unwrap();
                let mut stream = stream;
                let (status, len) = match &out {
                    Answer::Body(s, b) => (*s, b.len() as u64),
                    Answer::File(p) => (200, std::fs::metadata(p).unwrap().len()),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n"
                );
                let _ = match out {
                    Answer::Body(_, b) => stream.write_all(&b),
                    Answer::File(p) => {
                        std::io::copy(&mut std::fs::File::open(p).unwrap(), &mut stream).map(|_| ())
                    }
                };
                let _ = stream.flush();
            });
        }
    });
    base
}
