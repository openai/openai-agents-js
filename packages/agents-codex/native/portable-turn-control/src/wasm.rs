use super::portable::{MAX_FRAME, PortableTurn};
use std::cell::RefCell;

thread_local! {
    static TURN: RefCell<PortableTurn> = RefCell::default();
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(length: usize) -> *mut u8 {
    if length > MAX_FRAME {
        return std::ptr::null_mut();
    }
    INPUT.with_borrow_mut(|input| {
        input.resize(length, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn apply() {
    let response = INPUT.with_borrow(|input| TURN.with_borrow_mut(|turn| turn.apply(input)));
    OUTPUT.with_borrow_mut(|out| *out = response);
    INPUT.with_borrow_mut(|input| input.clear());
}

#[unsafe(no_mangle)]
pub extern "C" fn output_pointer() -> *const u8 {
    OUTPUT.with_borrow(|out| out.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn output_length() -> usize {
    OUTPUT.with_borrow(|out| out.len())
}
