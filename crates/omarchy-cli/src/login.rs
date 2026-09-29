//! `omarchy-cli login --agent "<name>"`: a grant for an agent, made in the
//! person's own signed-in browser and handed to this command through a
//! loopback address (RFC 8252) with PKCE S256 (RFC 7636). The command listens
//! on `127.0.0.1`, on a port the system picks, and opens the pool's grant page
//! with the agent's name, the scopes, the port, a `state` and the challenge;
//! the person presses Grant; the pool sends the browser to
//! `http://127.0.0.1:<port>/` with a one-time code; the command checks the
//! `state` and swaps the code and its verifier — which never leaves this
//! command but for that swap, to the pool's own origin — for the token.
//! There is no other way in (no code to paste): the command needs a browser
//! on the same machine.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::api::{urlencode, Api};
use crate::credentials::{origin_of, Credentials};

/// How long the command waits for the browser to come back: as long as the
/// pool's grant page keeps its form good for (ten minutes), so a person who
/// reads the page before pressing Grant is never answered by a closed port.
pub const WAIT: Duration = Duration::from_secs(600);

/// What a login asks for.
pub struct Ask<'a> {
    pub agent: &'a str,
    pub scopes: &'a [&'a str],
    pub days: Option<u32>,
}

/// `n` random bytes from the system's generator.
pub fn random_bytes(n: usize) -> Result<Vec<u8>> {
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut b))
        .context("reading /dev/urandom")?;
    Ok(b)
}

/// base64url without padding (RFC 4648 §5), as PKCE writes its values.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(char::from(A[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// The S256 challenge of a verifier: base64url(sha256(verifier)).
pub fn challenge_of(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// The grant page's address on the pool: the agent's name, the scopes, the port, the state and the challenge — never the verifier.
pub fn grant_url(api: &str, ask: &Ask<'_>, port: u16, state: &str, challenge: &str) -> String {
    let mut url = format!(
        "{}/auth/agent?agent={}&scopes={}&port={port}&state={state}&challenge={challenge}&method=S256",
        api.trim_end_matches('/'),
        urlencode(ask.agent),
        urlencode(&ask.scopes.join(","))
    );
    if let Some(d) = ask.days {
        use std::fmt::Write as _;
        let _ = write!(url, "&days={d}");
    }
    url
}

/// A request to the loopback address: the grant's callback — `GET /?…`, its query's code (or error) and state — or None for anything else a browser may ask on its own (a favicon, a speculative connection that says nothing).
fn read_callback(stream: &mut TcpStream) -> Result<Option<Vec<(String, String)>>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    // The headers, read and dropped: nothing in them is needed.
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
    }
    let mut words = line.split_whitespace();
    let (method, target) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
    let Some(query) = target.strip_prefix("/?") else {
        return Ok(None);
    };
    if method != "GET" {
        return Ok(None);
    }
    Ok(Some(
        query
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_owned(), percent_decode(v)))
            .collect(),
    ))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn answer(stream: &mut TcpStream, status: &str, text: &str) {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><title>omarchy-cli</title><p style=\"font:15px system-ui;margin:3em\">{text}</p>\n");
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Waits for one connection on the listener, until `deadline`.
fn accept_one(listener: &TcpListener, deadline: Instant) -> Result<TcpStream> {
    listener.set_nonblocking(true)?;
    loop {
        match listener.accept() {
            Ok((s, _)) => {
                s.set_nonblocking(false)?;
                return Ok(s);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    bail!(
                        "no answer from the browser within {} minutes: run omarchy-cli login again",
                        WAIT.as_secs() / 60
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// The one callback with this login's state, and its query. Anything else is answered and the command waits on until the deadline: a
/// connection that says nothing, a request for something else (a favicon) — and a callback with another state, which a local process or
/// a page probing 127.0.0.1's ports may send: it grants nothing here, and it does not end the person's login either.
fn callback(
    listener: &TcpListener,
    state: &str,
    deadline: Instant,
) -> Result<(TcpStream, Vec<(String, String)>)> {
    loop {
        let mut s = accept_one(listener, deadline)?;
        match read_callback(&mut s) {
            Ok(Some(q)) if q.iter().any(|(k, v)| k == "state" && v == state) => return Ok((s, q)),
            Ok(Some(_)) => answer(
                &mut s,
                "400 Bad Request",
                "This answer is not for the login this command started: nothing was granted here.",
            ),
            Ok(None) => answer(
                &mut s,
                "404 Not Found",
                "Nothing here: this address takes the grant's answer only.",
            ),
            Err(_) => {}
        }
    }
}

/// The whole login: listen on 127.0.0.1, send the person to the grant page (`open` is handed its address), take the one callback that carries this login's state, swap the code with the verifier at the pool's own origin.
pub fn login(api: &Api, ask: &Ask<'_>, wait: Duration, open: &dyn Fn(&str)) -> Result<Credentials> {
    let origin = origin_of(api.base()).context("the API address is not an http(s) URL")?;
    let verifier = b64url(&random_bytes(32)?);
    let state = b64url(&random_bytes(24)?);
    // 127.0.0.1 only, on a port the system picks: nothing else on the network can answer the browser.
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("listening on 127.0.0.1")?;
    let port = listener.local_addr()?.port();
    open(&grant_url(
        api.base(),
        ask,
        port,
        &state,
        &challenge_of(&verifier),
    ));
    let (mut stream, q) = callback(&listener, &state, Instant::now() + wait)?;
    drop(listener);
    let get = |k: &str| q.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
    if let Some(e) = get("error") {
        answer(
            &mut stream,
            "200 OK",
            "Not granted. You can close this tab.",
        );
        bail!("not granted in the browser ({e})");
    }
    let Some(code) = get("code").map(str::to_owned) else {
        answer(
            &mut stream,
            "400 Bad Request",
            "No code came back: run omarchy-cli login again.",
        );
        bail!("the browser came back without a code");
    };
    // The swap, at the pool's own origin: the code and the verifier, never in the browser's address.
    let swapped = api.call(
        "POST",
        "/auth/agent/token",
        Some(&json!({ "code": code, "code_verifier": verifier })),
        None,
    );
    let v = match swapped {
        Ok(v) => v,
        Err(e) => {
            answer(
                &mut stream,
                "502 Bad Gateway",
                "The pool did not take the code: run omarchy-cli login again.",
            );
            return Err(e);
        }
    };
    answer(
        &mut stream,
        "200 OK",
        "Granted. You can close this tab and go back to the terminal.",
    );
    let s = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    let token = s("token")
        .filter(|t| t.starts_with("oma_"))
        .context("the pool answered no agent token")?;
    Ok(Credentials {
        origin,
        token,
        grant: s("grant").unwrap_or_default(),
        login: s("login").unwrap_or_default(),
        agent: s("agent").unwrap_or_else(|| ask.agent.to_owned()),
        scopes: v
            .get("scopes")
            .and_then(serde_json::Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        expires_at: s("expires_at").unwrap_or_default(),
    })
}

/// Opens the address in the person's browser (xdg-open, or open on macOS); the command prints it too.
pub fn open_browser(url: &str) {
    for cmd in ["xdg-open", "open"] {
        if std::process::Command::new(cmd)
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The browser's thread, handed out of the `open` callback.
    type Back<T> = Arc<Mutex<Option<std::thread::JoinHandle<T>>>>;

    #[test]
    fn pkce_is_rfc_7636s() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
        assert_eq!(b64url(&random_bytes(32).unwrap()).len(), 43);
        assert_eq!(percent_decode("a%20b+c%2F"), "a b c/");
    }

    /// A pool that answers the swap: it records the body and checks the verifier against the challenge the grant page was given.
    fn pool(challenge: Arc<Mutex<String>>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0u8; len];
                reader.read_exact(&mut body).unwrap();
                let body = String::from_utf8(body).unwrap();
                log.lock().unwrap().push(format!("{} {body}", line.trim()));
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                let ok = v["code"] == "the-code"
                    && challenge_of(v["code_verifier"].as_str().unwrap_or(""))
                        == *challenge.lock().unwrap();
                let (status, out) = if ok {
                    (
                        "200 OK",
                        json!({ "token": format!("oma_{}", "1".repeat(48)), "grant": "g_1", "login": "bob", "agent": "Claude Code", "scopes": ["contribute"], "expires_at": "2999-01-01T00:00:00.000Z" }),
                    )
                } else {
                    (
                        "400 Bad Request",
                        json!({ "error": "the code is not valid", "code": "invalid_grant" }),
                    )
                };
                let out = out.to_string();
                let _ = write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}", out.len());
            }
        });
        (base, seen)
    }

    /// The browser, coming back to the loopback address the grant page named.
    fn browser_back(url: &str, query: &str) -> std::thread::JoinHandle<String> {
        let port: u16 = url
            .split("port=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let query = query.to_owned();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(
                s,
                "GET /?{query} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\n\r\n"
            )
            .unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        })
    }

    fn param(url: &str, k: &str) -> String {
        url.split(&format!("{k}="))
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn listens_on_127_0_0_1_takes_one_callback_and_swaps_the_verifier_at_the_pools_origin_only() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let (base, seen) = pool(Arc::clone(&challenge));
        let api = Api::new(&base).unwrap();
        let opened = Arc::new(Mutex::new(String::new()));
        let back: Arc<Mutex<Option<std::thread::JoinHandle<String>>>> = Arc::new(Mutex::new(None));
        let (o, b, c) = (
            Arc::clone(&opened),
            Arc::clone(&back),
            Arc::clone(&challenge),
        );
        let creds = login(
            &api,
            &Ask {
                agent: "Claude Code",
                scopes: &["contribute"],
                days: Some(10),
            },
            Duration::from_secs(20),
            &|url: &str| {
                *o.lock().unwrap() = url.to_owned();
                *c.lock().unwrap() = param(url, "challenge");
                *b.lock().unwrap() = Some(browser_back(
                    url,
                    &format!("code=the-code&state={}", param(url, "state")),
                ));
            },
        )
        .unwrap();
        let page = String::from_utf8(
            back.lock()
                .unwrap()
                .take()
                .unwrap()
                .join()
                .unwrap()
                .into_bytes(),
        )
        .unwrap();
        assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
        let url = opened.lock().unwrap().clone();
        // The grant page's address: the pool's origin, the agent, the scopes, a port, the state and the challenge — the verifier never.
        assert!(
            url.starts_with(&format!(
                "{base}/auth/agent?agent=Claude%20Code&scopes=contribute&port="
            )),
            "{url}"
        );
        assert!(
            url.contains("&method=S256") && url.ends_with("&days=10"),
            "{url}"
        );
        let swaps = seen.lock().unwrap().clone();
        assert_eq!(swaps.len(), 1, "{swaps:?}");
        assert!(
            swaps[0].starts_with("POST /auth/agent/token HTTP/1.1 {"),
            "{swaps:?}"
        );
        let sent: serde_json::Value =
            serde_json::from_str(&swaps[0][swaps[0].find('{').unwrap()..]).unwrap();
        let verifier = sent["code_verifier"].as_str().unwrap().to_owned();
        assert_eq!(verifier.len(), 43);
        assert!(!url.contains(&verifier));
        assert_eq!(creds.origin, base);
        assert_eq!(creds.token, format!("oma_{}", "1".repeat(48)));
        assert_eq!(
            (
                creds.login.as_str(),
                creds.agent.as_str(),
                creds.scopes.clone()
            ),
            ("bob", "Claude Code", vec!["contribute".to_owned()])
        );
        // One callback, then the address is closed.
        let port: u16 = param(&url, "port").parse().unwrap();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }

    #[test]
    fn a_request_that_is_not_the_callback_is_answered_and_the_login_waits_for_the_callback() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let (base, _) = pool(Arc::clone(&challenge));
        let api = Api::new(&base).unwrap();
        let back: Arc<Mutex<Option<std::thread::JoinHandle<String>>>> = Arc::new(Mutex::new(None));
        let (b, c) = (Arc::clone(&back), Arc::clone(&challenge));
        let creds = login(
            &api,
            &Ask {
                agent: "Codex",
                scopes: &["contribute"],
                days: None,
            },
            Duration::from_secs(20),
            &|url: &str| {
                *c.lock().unwrap() = param(url, "challenge");
                // The browser, in its own thread while the command listens: a connection that says nothing, a favicon, then the callback.
                let url = url.to_owned();
                *b.lock().unwrap() = Some(std::thread::spawn(move || {
                    let port: u16 = param(&url, "port").parse().unwrap();
                    drop(TcpStream::connect(("127.0.0.1", port)).unwrap());
                    let mut f = TcpStream::connect(("127.0.0.1", port)).unwrap();
                    write!(f, "GET /favicon.ico HTTP/1.1\r\nhost: x\r\n\r\n").unwrap();
                    let mut out = String::new();
                    let _ = f.read_to_string(&mut out);
                    assert!(out.starts_with("HTTP/1.1 404"), "{out}");
                    browser_back(
                        &url,
                        &format!("code=the-code&state={}", param(&url, "state")),
                    )
                    .join()
                    .unwrap()
                }));
            },
        )
        .unwrap();
        assert_eq!(creds.login, "bob");
        assert!(back
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .join()
            .unwrap()
            .starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn a_callback_with_another_state_is_answered_400_and_the_login_waits_for_its_own() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let (base, seen) = pool(Arc::clone(&challenge));
        let api = Api::new(&base).unwrap();
        let back: Back<(String, String)> = Arc::new(Mutex::new(None));
        let (b, c) = (Arc::clone(&back), Arc::clone(&challenge));
        // A page probing 127.0.0.1's ports, or another process, sends a callback with a state of its own first: answered 400, and the login waits on.
        let creds = login(
            &api,
            &Ask {
                agent: "Codex",
                scopes: &["contribute"],
                days: None,
            },
            Duration::from_secs(20),
            &|url: &str| {
                assert!(!url.contains("days="));
                *c.lock().unwrap() = param(url, "challenge");
                let url = url.to_owned();
                *b.lock().unwrap() = Some(std::thread::spawn(move || {
                    let stray = browser_back(&url, "code=the-code&state=somebody-elses")
                        .join()
                        .unwrap();
                    let own = browser_back(
                        &url,
                        &format!("code=the-code&state={}", param(&url, "state")),
                    )
                    .join()
                    .unwrap();
                    (stray, own)
                }));
            },
        )
        .unwrap();
        assert_eq!(creds.login, "bob");
        let (stray, own) = back.lock().unwrap().take().unwrap().join().unwrap();
        assert!(stray.starts_with("HTTP/1.1 400"), "{stray}");
        assert!(own.starts_with("HTTP/1.1 200"), "{own}");
        // One swap, the login's own: the stray callback's code went nowhere.
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_callback_with_another_state_alone_swaps_nothing_and_the_login_ends_at_its_deadline() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let (base, seen) = pool(Arc::clone(&challenge));
        let api = Api::new(&base).unwrap();
        let back: Arc<Mutex<Option<std::thread::JoinHandle<String>>>> = Arc::new(Mutex::new(None));
        let b = Arc::clone(&back);
        let e = login(
            &api,
            &Ask {
                agent: "Codex",
                scopes: &["contribute"],
                days: None,
            },
            Duration::from_secs(2),
            &|url: &str| {
                *b.lock().unwrap() = Some(browser_back(url, "code=the-code&state=somebody-elses"));
            },
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("no answer from the browser"), "{e}");
        assert!(back
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .join()
            .unwrap()
            .starts_with("HTTP/1.1 400"));
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_grant_denied_in_the_browser_is_said_and_nothing_is_swapped() {
        let challenge = Arc::new(Mutex::new(String::new()));
        let (base, seen) = pool(Arc::clone(&challenge));
        let api = Api::new(&base).unwrap();
        let back: Arc<Mutex<Option<std::thread::JoinHandle<String>>>> = Arc::new(Mutex::new(None));
        // Denied in the browser: said so, nothing swapped.
        let b2 = Arc::clone(&back);
        let e = login(
            &api,
            &Ask {
                agent: "Codex",
                scopes: &["contribute"],
                days: None,
            },
            Duration::from_secs(20),
            &|url: &str| {
                *b2.lock().unwrap() = Some(browser_back(
                    url,
                    &format!("state={}&error=access_denied", param(url, "state")),
                ));
            },
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("not granted in the browser"), "{e}");
        back.lock().unwrap().take().unwrap().join().unwrap();
        assert!(seen.lock().unwrap().is_empty());
    }
}
