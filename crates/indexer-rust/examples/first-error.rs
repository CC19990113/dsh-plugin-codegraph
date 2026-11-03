//! Debug helper: report the first syntax error a grammar produces for a file.
//!
//! `cargo run --release --example first-error -- <language> <path>`
//!
//! Used to compare this crate's grammar version against the JS side's WASM build when a
//! parity check diverges: the earliest error node names the construct whose parse differs.

use std::env;
use std::fs;

use tree_sitter::{Language, Node, Parser};

fn grammar(language: &str) -> Language {
    match language {
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" | "jsx" => tree_sitter_javascript::LANGUAGE.into(),
        other => panic!("unsupported language {other:?}"),
    }
}

fn collect_errors<'tree>(node: Node<'tree>, found: &mut Vec<Node<'tree>>) {
    if node.is_error() || node.is_missing() {
        found.push(node);
        if found.len() > 20 {
            return;
        }
    }
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index) {
            collect_errors(child, found);
        }
    }
}

fn main() {
    let mut arguments = env::args().skip(1);
    let language = arguments.next().expect("usage: first-error <language> <path>");
    let path = arguments.next().expect("usage: first-error <language> <path>");
    let source = fs::read_to_string(&path).expect("read source");
    let mut parser = Parser::new();
    parser
        .set_language(&grammar(&language))
        .expect("grammar loads");
    let tree = parser.parse(&source, None).expect("tree");
    let root = tree.root_node();
    println!("root: {:?}, has_error={}", root.kind(), root.has_error());
    let mut found = Vec::new();
    collect_errors(root, &mut found);
    println!("rust errors: {}", found.len());
    for node in found.iter().take(5) {
        let start = node.start_position();
        let end = (node.start_byte() + 80).min(node.end_byte()).min(source.len());
        println!(
            "  {:?} missing={} {}:{}-{}:{} {:?}",
            node.kind(),
            node.is_missing(),
            start.row + 1,
            start.column,
            node.end_position().row + 1,
            node.end_position().column,
            &source[node.start_byte()..end],
        );
    }
}
