interface ImportMetaEnv {
  /**
   * Dev only (`vite dev`); ignored by production builds. "missing" serves the endpoints the
   * backend doesn't have yet from src/web/mock and sends the rest to the local Worker; "all"
   * serves everything from the mock, so the app runs on synthetic data alone.
   */
  readonly VITE_MOCK_API?: "missing" | "all";
}
