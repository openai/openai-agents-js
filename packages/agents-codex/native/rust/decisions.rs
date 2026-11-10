//! Pure schema adaptation for the standalone Decisions provider.

use codex_api::decisions::{DecisionError, DecisionSchema};
use napi::{Error, Result, Status};
use napi_derive::napi;
use serde_json::{Value, json};

fn invalid(message: impl ToString) -> Error {
    Error::new(Status::InvalidArg, message.to_string())
}

#[napi(js_name = "_decision_questions")]
pub fn decision_questions(schema_json: String, question: String) -> Result<String> {
    let schema: Value = serde_json::from_str(&schema_json)
        .map_err(|_| invalid("invalid Decisions output schema"))?;
    let result = match DecisionSchema::compile(&schema, &question) {
        Some(plan) => json!({"supported":true,"questions":plan.questions()}),
        None => json!({"supported":false,"questions":[]}),
    };
    serde_json::to_string(&result).map_err(|_| invalid("invalid Decisions output schema"))
}

#[napi(js_name = "_decision_result")]
pub fn decision_result(
    schema_json: String,
    question: String,
    answers_json: String,
) -> Result<String> {
    let schema: Value = serde_json::from_str(&schema_json)
        .map_err(|_| invalid("invalid Decisions output schema"))?;
    let plan = DecisionSchema::compile(&schema, &question)
        .ok_or_else(|| invalid(DecisionError::UnsupportedSchema))?;
    let answers: Vec<Value> =
        serde_json::from_str(&answers_json).map_err(|_| invalid(DecisionError::InvalidAnswer))?;
    let value = plan.decode(&answers).map_err(invalid)?;
    serde_json::to_string(&value).map_err(|_| invalid(DecisionError::InvalidAnswer))
}
