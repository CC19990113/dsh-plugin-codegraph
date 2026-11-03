//! Benchmark-only harness: measures the two phases the JS baseline reports separately
//! (parse, then extract) over a pre-collected batch of files.
//!
//! Not part of the addon contract — `cargo run --release --example bench -- <inputs.json>
//! <language-rules.json>`. `inputs.json` is written by `tools/parity-adx.mjs`, which
//! collects the same files the JS walker produced so both sides see one identical set.

use std::env;
use std::fs;
use std::time::Instant;

use dsh_plugin_codegraph_indexer::{extract_file, parse_rules, LanguageSpec};
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
    let mut arguments = env::args().skip(1);
    let inputs_path = arguments.next().expect("usage: bench <inputs.json> <rules.json>");
    let rules_path = arguments.next().expect("usage: bench <inputs.json> <rules.json>");
    let specs: Vec<LanguageSpec> =
        parse_rules(&fs::read_to_string(&rules_path).expect("read rules")).expect("parse rules");
    let inputs: Vec<Input> = serde_json::from_str(&fs::read_to_string(&inputs_path).expect("read inputs"))
        .expect("parse inputs");
    let bytes: usize = inputs.iter().map(|input| input.text.len()).sum();
    let longest = inputs.iter().max_by_key(|input| input.text.len());

    let mut parser = Parser::new();
    let mut parse_time = std::time::Duration::ZERO;
    let mut extract_time = std::time::Duration::ZERO;
    for input in &inputs {
        let spec = specs
            .iter()
            .find(|spec| spec.language == input.language)
            .expect("spec for language");
        parser
            .set_language(&grammar(&input.language))
            .expect("grammar loads");
        let started = Instant::now();
        let tree = parser.parse(&input.text, None).expect("parse produces a tree");
        parse_time += started.elapsed();
        let started = Instant::now();
        let extraction = extract_file(&tree, &input.text, spec);
        extract_time += started.elapsed();
        std::hint::black_box(&extraction);
    }

    // Serialization cost is measured on the already-extracted batch, so it is not paying
    // for a second parse.
    let mut extractions = Vec::with_capacity(inputs.len());
    for input in &inputs {
        let spec = specs
            .iter()
            .find(|spec| spec.language == input.language)
            .expect("spec for language");
        parser.set_language(&grammar(&input.language)).expect("grammar loads");
        let tree = parser.parse(&input.text, None).expect("tree");
        extractions.push(extract_file(&tree, &input.text, spec));
    }
    let started = Instant::now();
    let json = serde_json::to_string(&extractions).expect("serialize");
    let serialize = started.elapsed();
    let _ = json.len();

    println!(
        "files={} bytes={} parse={:.1}ms extract={:.1}ms serialize={:.1}ms total={:.1}ms cores={}",
        inputs.len(),
        bytes,
        parse_time.as_secs_f64() * 1000.0,
        extract_time.as_secs_f64() * 1000.0,
        serialize.as_secs_f64() * 1000.0,
        (parse_time + extract_time + serialize).as_secs_f64() * 1000.0,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
    );
    if let Some(longest) = longest {
        println!("longest file: {} ({} bytes)", longest.path, longest.text.len());
    }
}
