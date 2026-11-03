fn main() {
    // napi-build supplies the link flags (and the `-undefined dynamic_lookup` on
    // macOS) that let the cdylib resolve node-api symbols from the host process.
    napi_build::setup();
}
