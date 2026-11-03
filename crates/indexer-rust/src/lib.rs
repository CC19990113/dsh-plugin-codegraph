//! The napi entry point: one batch call over many files, parsed and extracted in
//! parallel on rayon, answered as a JSON string.
//!
//! The JS side (`packages/tree-sitter/src/walk.ts`) already has every file's text in
//! memory when it calls here — this crate never reads or writes a file. That keeps the
//! seam honest: the walk owns filesystem policy (mtime, minified skips, cache reuse)
//! and this crate owns only parse+extract.

mod extract;
mod languages;
mod rules;

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

use napi_derive::napi;
use rayon::prelude::*;
use serde::Serialize;

pub use extract::{extract_file, FileExtraction, RawCall, RawDefinition, RawHeritageRef, RawImport};
pub use languages::{parse_rules, LanguageSpec, SUPPORTED_LANGUAGES};

/// One file to parse, as the JS side hands it over.
#[napi(object)]
pub struct ExtractInput {
    /// Workspace-relative path, echoed back verbatim in `results[].path`.
    pub path: String,
    /// Seam language label: `typescript` | `tsx` | `javascript` | `jsx`.
    pub language: String,
    /// The file's full text.
    pub text: String,
}

/// One file's extraction, tagged with the path it belongs to.
#[derive(Serialize)]
struct ExtractionResult {
    path: String,
    extraction: FileExtraction,
}

/// The whole batch answer.
#[derive(Serialize)]
struct WorkspaceOutput {
    results: Vec<ExtractionResult>,
    /// The language labels this addon can extract, derived from `rulesJson` — the JS
    /// side routes only those languages here and falls back for everything else.
    supported: Vec<String>,
}

/// One unit of parallel work: a supported input plus the spec that governs it.
struct Job<'a> {
    path: &'a str,
    text: &'a str,
    spec: &'a LanguageSpec,
}

/// Extract definitions, calls, imports, and heritage for a batch of files.
///
/// Returns a JSON string of `{ results: [{ path, extraction }], supported: string[] }`.
/// Inputs in a language this addon does not handle are skipped, not errored: the JS
/// side falls back to its own extractor for them. A malformed `rulesJson` is an error,
/// because extracting with no rules would report an empty graph as truth.
///
/// A file whose parse tree contains syntax errors is **omitted** from `results` (it never
/// affects `supported`, which is a per-language list). The two engines' error-recovery
/// strategies differ, so each side extracts the files it parses cleanly and the caller falls
/// back to the JS extractor for every missing path — otherwise a file both engines only
/// half-parse would contribute two different sets of garbage to the graph.
#[napi(js_name = "extractWorkspace")]
pub fn extract_workspace(inputs: Vec<ExtractInput>, rules_json: String) -> napi::Result<String> {
    // A panic here would otherwise abort the Node process; napi cannot turn that into a
    // rejected promise on its own, so the whole body runs inside catch_unwind.
    match catch_unwind(AssertUnwindSafe(|| run(&inputs, &rules_json))) {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(message)) => Err(napi::Error::new(napi::Status::GenericFailure, message)),
        Err(panic) => Err(napi::Error::new(
            napi::Status::GenericFailure,
            format!("codegraph indexer panicked: {}", panic_message(&panic)),
        )),
    }
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic payload".to_string()
    }
}

fn run(inputs: &[ExtractInput], rules_json: &str) -> Result<String, String> {
    let specs = parse_rules(rules_json)?;
    let mut by_language: HashMap<&str, &LanguageSpec> = HashMap::new();
    let mut supported: Vec<String> = Vec::new();
    for spec in &specs {
        if !languages::is_supported(&spec.language) || languages::grammar_for(&spec.language).is_none()
        {
            continue;
        }
        if by_language.insert(spec.language.as_str(), spec).is_none() {
            supported.push(spec.language.clone());
        }
    }

    let jobs: Vec<Job<'_>> = inputs
        .iter()
        .filter_map(|input| {
            let spec = by_language.get(input.language.as_str())?;
            Some(Job {
                path: &input.path,
                text: &input.text,
                spec,
            })
        })
        .collect();

    // `map_init` gives every rayon worker one reused parser; `set_language` per item
    // keeps mixed-language batches correct without paying a parser construction cost.
    // `None` means "leave this path out of the answer" — see `extract_workspace`'s doc.
    let extracted: Vec<Result<Option<ExtractionResult>, String>> = jobs
        .par_iter()
        .map_init(
            tree_sitter::Parser::new,
            |parser, job| -> Result<Option<ExtractionResult>, String> {
                let language = languages::grammar_for(&job.spec.language)
                    .ok_or_else(|| format!("no grammar for language {:?}", job.spec.language))?;
                parser
                    .set_language(&language)
                    .map_err(|error| format!("cannot load {:?} grammar: {error}", job.spec.language))?;
                let tree = parser
                    .parse(job.text, None)
                    .ok_or_else(|| format!("parse returned no tree for {}", job.path))?;
                // Error recovery is grammar-version-specific: extracting from a recovered tree
                // would put a second, different interpretation of a broken file into the graph.
                // Omit the path so the caller extracts it with its own parser instead.
                if tree.root_node().has_error() {
                    return Ok(None);
                }
                Ok(Some(ExtractionResult {
                    path: job.path.to_string(),
                    extraction: extract_file(&tree, job.text, job.spec),
                }))
            },
        )
        .collect();

    let mut results = Vec::with_capacity(extracted.len());
    for result in extracted {
        if let Some(result) = result? {
            results.push(result);
        }
    }

    serde_json::to_string(&WorkspaceOutput { results, supported })
        .map_err(|error| format!("cannot serialize extraction: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules_for(languages: &[&str]) -> String {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/language-rules.json"))
                .expect("bundled rules parse");
        let filtered: Vec<serde_json::Value> = table
            .as_array()
            .expect("rules are an array")
            .iter()
            .filter(|spec| {
                spec["language"]
                    .as_str()
                    .map(|language| languages.contains(&language))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        serde_json::to_string(&filtered).expect("rules serialize")
    }

    #[test]
    fn unsupported_languages_are_skipped_and_reported() {
        let rules = rules_for(&["typescript", "python"]);
        let inputs = vec![
            ExtractInput {
                path: "a.ts".to_string(),
                language: "typescript".to_string(),
                text: "export function foo() {}\n".to_string(),
            },
            ExtractInput {
                path: "b.py".to_string(),
                language: "python".to_string(),
                text: "def foo(): pass\n".to_string(),
            },
        ];
        let json = run(&inputs, &rules).expect("batch extraction");
        let value: serde_json::Value = serde_json::from_str(&json).expect("json");
        assert_eq!(value["supported"], serde_json::json!(["typescript"]));
        assert_eq!(value["results"].as_array().expect("results").len(), 1);
        assert_eq!(value["results"][0]["path"], "a.ts");
    }

    #[test]
    fn files_with_parse_errors_are_omitted_so_the_js_side_can_fall_back() {
        let rules = rules_for(&["typescript"]);
        let inputs = vec![
            ExtractInput {
                path: "broken.ts".to_string(),
                language: "typescript".to_string(),
                // Unrecoverable: this cannot parse as a declaration.
                text: "function broken( {\n  const = ;\n}\n".to_string(),
            },
            ExtractInput {
                path: "ok.ts".to_string(),
                language: "typescript".to_string(),
                text: "export const ok = 1\n".to_string(),
            },
        ];
        let json = run(&inputs, &rules).expect("batch extraction");
        let value: serde_json::Value = serde_json::from_str(&json).expect("json");
        let paths: Vec<&str> = value["results"]
            .as_array()
            .expect("results")
            .iter()
            .map(|result| result["path"].as_str().expect("path"))
            .collect();
        assert_eq!(
            paths,
            vec!["ok.ts"],
            "a file whose parse has errors must be omitted, not extracted"
        );
        // Omission is per file; the language list is unchanged.
        assert_eq!(value["supported"], serde_json::json!(["typescript"]));
    }

    #[test]
    fn malformed_rules_json_is_an_error() {
        let error = run(&[], "not json").expect_err("must fail");
        assert!(error.contains("rulesJson"), "unexpected error: {error}");
    }
}
