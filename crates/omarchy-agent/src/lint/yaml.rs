//! A small, hardened YAML reader for compose templates.
//!
//! The lint must read a file the way compose will, or an invariant could be checked on
//! something compose never sees. So anything whose meaning could differ between this
//! reader and compose is refused rather than interpreted: more than one document, tags
//! (`!reset`, `!override`, `!!str`), merge keys (`<<`), duplicate keys and non-scalar keys.
//! Aliases are expanded, within a node budget, so a "billion laughs" file is refused
//! instead of filling memory. Scalars stay text: the lint compares what was written.

use std::collections::HashMap;

use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

const MAX_BYTES: usize = 256 << 10;
const MAX_NODES: usize = 20_000;
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Node {
    /// `~`, `null` or nothing, written plain.
    Null,
    Scalar(String),
    Seq(Vec<Node>),
    /// In file order; keys are unique.
    Map(Vec<(String, Node)>),
}

impl Node {
    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Node::Scalar(s) => Some(s),
            _ => None,
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn size(&self) -> usize {
        1 + match self {
            Node::Seq(items) => items.iter().map(Node::size).sum(),
            Node::Map(entries) => entries.iter().map(|(_, v)| 1 + v.size()).sum(),
            Node::Null | Node::Scalar(_) => 0,
        }
    }
}

enum Frame {
    Seq(Vec<Node>, usize),
    Map(Vec<(String, Node)>, Option<String>, usize),
}

struct Builder {
    stack: Vec<Frame>,
    anchors: HashMap<usize, Node>,
    nodes: usize,
    root: Option<Node>,
}

impl Builder {
    fn count(&mut self, n: usize) -> Result<(), String> {
        self.nodes += n;
        if self.nodes > MAX_NODES {
            return Err(format!(
                "more than {MAX_NODES} nodes once aliases are expanded"
            ));
        }
        Ok(())
    }

    fn open(&mut self, frame: Frame) -> Result<(), String> {
        self.count(1)?;
        if self.stack.len() >= MAX_DEPTH {
            return Err(format!("nested deeper than {MAX_DEPTH}"));
        }
        self.stack.push(frame);
        Ok(())
    }

    fn finish(&mut self, node: Node, anchor: usize) -> Result<(), String> {
        if anchor > 0 {
            self.anchors.insert(anchor, node.clone());
        }
        match self.stack.last_mut() {
            None => {
                if self.root.replace(node).is_some() {
                    return Err("more than one root node".into());
                }
            }
            Some(Frame::Seq(items, _)) => items.push(node),
            Some(Frame::Map(entries, key @ None, _)) => {
                let Node::Scalar(k) = node else {
                    return Err("a mapping key that is not a plain value".into());
                };
                if k == "<<" {
                    return Err("merge keys (<<) are not in the template subset".into());
                }
                if entries.iter().any(|(e, _)| *e == k) {
                    return Err(format!("duplicate key {k:?}"));
                }
                *key = Some(k);
            }
            Some(Frame::Map(entries, key @ Some(_), _)) => {
                let k = key.take().expect("matched Some");
                entries.push((k, node));
            }
        }
        Ok(())
    }
}

fn no_tag<T>(tag: Option<&T>) -> Result<(), String> {
    match tag {
        None => Ok(()),
        Some(_) => {
            Err("YAML tags (!reset, !override, !!str, ...) are not in the template subset".into())
        }
    }
}

pub(crate) fn parse(src: &str) -> Result<Node, String> {
    if src.len() > MAX_BYTES {
        return Err(format!("larger than {} KiB", MAX_BYTES >> 10));
    }
    let mut parser = Parser::new_from_str(src);
    let mut b = Builder {
        stack: Vec::new(),
        anchors: HashMap::new(),
        nodes: 0,
        root: None,
    };
    let mut documents = 0;
    loop {
        let (event, mark) = parser.next_token().map_err(|e| e.to_string())?;
        let at = |e: String| format!("line {}: {e}", mark.line());
        match event {
            Event::StreamEnd => break,
            Event::Nothing | Event::StreamStart | Event::DocumentEnd => {}
            Event::DocumentStart => {
                documents += 1;
                if documents > 1 {
                    return Err(at("more than one YAML document".into()));
                }
            }
            Event::Scalar(value, style, anchor, tag) => {
                no_tag(tag.as_ref()).map_err(at)?;
                b.count(1).map_err(at)?;
                let plain_null = style == TScalarStyle::Plain
                    && matches!(value.as_str(), "" | "~" | "null" | "Null" | "NULL");
                let node = if plain_null {
                    Node::Null
                } else {
                    Node::Scalar(value)
                };
                b.finish(node, anchor).map_err(at)?;
            }
            Event::SequenceStart(anchor, tag) => {
                no_tag(tag.as_ref()).map_err(at)?;
                b.open(Frame::Seq(Vec::new(), anchor)).map_err(at)?;
            }
            Event::MappingStart(anchor, tag) => {
                no_tag(tag.as_ref()).map_err(at)?;
                b.open(Frame::Map(Vec::new(), None, anchor)).map_err(at)?;
            }
            Event::SequenceEnd => match b.stack.pop() {
                Some(Frame::Seq(items, anchor)) => {
                    b.finish(Node::Seq(items), anchor).map_err(at)?;
                }
                _ => return Err(at("unbalanced sequence".into())),
            },
            Event::MappingEnd => match b.stack.pop() {
                Some(Frame::Map(entries, None, anchor)) => {
                    b.finish(Node::Map(entries), anchor).map_err(at)?;
                }
                _ => return Err(at("unbalanced mapping".into())),
            },
            Event::Alias(id) => {
                let node = b
                    .anchors
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| at("an alias to no anchor".into()))?;
                b.count(node.size()).map_err(at)?;
                b.finish(node, 0).map_err(at)?;
            }
        }
    }
    b.root.ok_or_else(|| "an empty file".into())
}

#[cfg(test)]
mod tests {
    use super::{parse, Node};

    #[test]
    fn reads_maps_sequences_scalars_and_aliases() {
        let n = parse(
            "x-env: &env {A: \"1\"}\nservices:\n  d:\n    environment: *env\n    command: [a, ~]\n",
        )
        .unwrap();
        let env = n
            .get("services")
            .unwrap()
            .get("d")
            .unwrap()
            .get("environment")
            .unwrap();
        assert_eq!(env.get("A").unwrap().as_str(), Some("1"));
        let cmd = n
            .get("services")
            .unwrap()
            .get("d")
            .unwrap()
            .get("command")
            .unwrap();
        assert_eq!(cmd, &Node::Seq(vec![Node::Scalar("a".into()), Node::Null]));
    }

    #[test]
    fn refuses_what_compose_could_read_otherwise() {
        for (src, why) in [
            ("a: 1\na: 2\n", "duplicate"),
            ("a: 1\n---\nb: 2\n", "more than one"),
            ("a: !reset null\n", "tags"),
            ("a: !override [x]\n", "tags"),
            ("a: !!str 1\n", "tags"),
            ("x: &x {k: v}\ny:\n  <<: *x\n", "merge"),
            ("? [a]\n: b\n", "key"),
            ("a: *nothing\n", "anchor"),
            ("", "empty"),
            ("a: [", "while parsing"),
        ] {
            let e = parse(src).unwrap_err();
            assert!(e.contains(why), "{src:?}: {e}");
        }
    }

    #[test]
    fn refuses_alias_bombs_and_deep_nesting() {
        use std::fmt::Write as _;
        let mut src = String::from("a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n");
        for i in 1..10 {
            let prev = format!("*a{}", i - 1);
            writeln!(src, "a{i}: &a{i} [{}]", [prev.as_str(); 10].join(", ")).unwrap();
        }
        assert!(parse(&src).unwrap_err().contains("nodes"));
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let e = parse(&deep).unwrap_err();
        assert!(e.contains("deeper") || e.contains("recursion"), "{e}");
    }
}
