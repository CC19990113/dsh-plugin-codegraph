//! The extraction table, driven entirely by the JSON the JS side sends.
//!
//! `packages/tree-sitter/src/languages.ts` owns `LANGUAGE_TABLE`; this crate never
//! keeps a second copy of it. `rules_json` is that table's JSON (a bare array of
//! `LanguageSpec`, or an object with a `languages` array), and every rule for the
//! four ECMAScript-family grammars is read from it at call time.
//!
//! Field names are `camelCase` in the wire format because they come from a
//! TypeScript interface; each struct renames them back to Rust's `snake_case`.

use std::collections::HashMap;

use serde::Deserialize;
use tree_sitter::Language;

/// The four grammars this crate can load. A file in any other language is skipped
/// (never extracted with a guess), leaving the JS side free to fall back.
pub const SUPPORTED_LANGUAGES: [&str; 4] = ["typescript", "tsx", "javascript", "jsx"];

/// Whether this crate ships a grammar for `language`.
pub fn is_supported(language: &str) -> bool {
    SUPPORTED_LANGUAGES.contains(&language)
}

/// The `tree-sitter` grammar backing one seam language label.
///
/// `jsx` shares the plain JavaScript grammar: `tree-sitter-javascript` already parses
/// JSX syntax, and there is no separate JSX binary to load — the same fact
/// `LANGUAGE_TABLE`'s `jsx` entry records on the JS side.
pub fn grammar_for(language: &str) -> Option<Language> {
    match language {
        "typescript" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "javascript" | "jsx" => Some(tree_sitter_javascript::LANGUAGE.into()),
        _ => None,
    }
}

/// `DefinitionRule` — see `packages/tree-sitter/src/languages.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRule {
    pub node_type: String,
    pub kind: String,
    pub name_field: String,
    /// Present when the rule only matches a value of a particular shape.
    #[serde(default)]
    pub value: Option<ValueRule>,
    /// Present when the rule rejects name shapes it cannot represent as one name.
    #[serde(default)]
    pub name_node_types: Option<Vec<String>>,
    #[serde(default)]
    pub parent_type: Option<String>,
    #[serde(default)]
    pub grandparent_type: Option<String>,
    /// Present and `true` for a rule extracted only at module/class scope.
    #[serde(default)]
    pub scope_restricted: Option<bool>,
}

/// The field-plus-types pair a shape-conditional `DefinitionRule` carries.
#[derive(Debug, Clone, Deserialize)]
pub struct ValueRule {
    pub field: String,
    pub types: Vec<String>,
}

/// `LanguageSpec` — only the fields extraction reads. `extensions`/`wasmFile` are
/// deliberately absent: they describe loading, which is this crate's own business.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSpec {
    pub language: String,
    #[serde(default)]
    pub definitions: Vec<DefinitionRule>,
    #[serde(default)]
    pub call_types: Vec<String>,
    #[serde(default)]
    pub call_function_field: String,
    #[serde(default)]
    pub call_function_field_by_type: Option<HashMap<String, String>>,
    #[serde(default)]
    pub import_types: Vec<String>,
    #[serde(default)]
    pub bare_function_scope_types: Vec<String>,
}

/// Parse `rulesJson`. Accepts the bare `LanguageSpec[]` array the JS side builds from
/// `LANGUAGE_TABLE`, and — because a future caller may wrap it — an object holding the
/// same array under `languages`. Anything else is a hard error: silently extracting
/// with no rules would report an empty graph as truth.
pub fn parse_rules(rules_json: &str) -> Result<Vec<LanguageSpec>, String> {
    let value: serde_json::Value =
        serde_json::from_str(rules_json).map_err(|error| format!("rulesJson is not JSON: {error}"))?;
    let array = match value {
        serde_json::Value::Array(array) => array,
        serde_json::Value::Object(mut object) => match object.remove("languages") {
            Some(serde_json::Value::Array(array)) => array,
            _ => {
                return Err(
                    "rulesJson must be a LanguageSpec array, or an object with a `languages` array"
                        .to_string(),
                )
            }
        },
        _ => {
            return Err(
                "rulesJson must be a LanguageSpec array, or an object with a `languages` array"
                    .to_string(),
            )
        }
    };
    serde_json::from_value(serde_json::Value::Array(array))
        .map_err(|error| format!("rulesJson does not match LanguageSpec: {error}"))
}
