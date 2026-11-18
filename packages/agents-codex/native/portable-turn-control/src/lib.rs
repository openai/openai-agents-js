//! Turn continuation shared by Core and the portable text host.

/// Accumulates work admitted by the request's tool and input owners.
#[derive(Default)]
pub struct ResponseContinuation(bool);

impl ResponseContinuation {
    pub fn require_follow_up(&mut self, required: bool) {
        self.0 |= required;
    }

    pub fn complete(mut self, end_turn: Option<bool>) -> bool {
        self.require_follow_up(end_turn == Some(false));
        self.0
    }
}

#[cfg(any(test, target_arch = "wasm32"))]
mod portable;
#[cfg(any(test, target_arch = "wasm32"))]
mod portable_tracing;

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_respects_admitted_work_and_the_provider_terminal() {
        for pending in [false, true] {
            for end_turn in [None, Some(true), Some(false)] {
                let mut continuation = ResponseContinuation::default();
                continuation.require_follow_up(pending);
                assert_eq!(
                    continuation.complete(end_turn),
                    pending || end_turn == Some(false)
                );
            }
        }
    }
}
