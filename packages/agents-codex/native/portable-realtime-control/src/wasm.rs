//! Small synchronous ABI: every instance owns one control session and bounded input.
use super::Control;
use std::cell::RefCell;
thread_local! {
    static CONTROL: RefCell<Control> = RefCell::new(Control::default());
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(length: usize) -> *mut u8 {
    if length > super::MAX_FRAME_BYTES {
        return std::ptr::null_mut();
    }
    INPUT.with_borrow_mut(|input| {
        input.resize(length, 0);
        input.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn apply() {
    let output = INPUT.with_borrow(|input| match std::str::from_utf8(input) {
        Ok(input) => CONTROL.with_borrow_mut(|control| control.apply_json(input)),
        Err(_) => "{\"error\":\"Invalid UTF-8 command\"}".into(),
    });
    OUTPUT.with_borrow_mut(|out| *out = output.into_bytes());
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
