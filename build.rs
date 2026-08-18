// napi-build writes the linker arguments an addon needs on the
// platform it is being built for: the undefined-symbol allowance macOS
// wants, the import library Windows wants, and nothing at all on
// Linux. It is the whole build script and there is no code generation
// behind it.
fn main() {
    napi_build::setup();
}
