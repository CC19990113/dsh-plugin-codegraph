//! Verification helper: which files does this crate's grammar parse into an error tree?
//!
//! `cargo run --release --example parse-errors -- <inputs.json>`
//!
//! Prints one `has_error<TAB>path` line per file. Used to prove that the files the addon
//! omits from its answer are exactly the ones its own parser could not parse cleanly (the
//! JS-side fallback policy), not an accidental drop.

use std::env;
use std::fs;

use serde::Deserialize;
use tree_sitter::{Language, Parser};

#[derive(Deserialize)]
struct Input {
    path: String,
    language: String,
    text: String,
}

fn grammar(language: &str) -> Language {
    match language {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        other => panic!("unsupported language {other:?}"),
    }
}

fn main() {
    let path = env::args().nth(1).expect("usage: parse-errors <inputs.json>");
    let inputs: Vec<Input> = serde_json::from_str(&fs::read_to_string(&path).expect("read inputs"))
        .expect("parse inputs");
    let mut parser = Parser::new();
    for input in &inputs {
        parser
            .set_language(&grammar(&input.language))
            .expect("grammar loads");
        let tree = parser.parse(&input.text, None).expect("tree");
        println!("{}\t{}", tree.root_node().has_error(), input.path);
    }
}
