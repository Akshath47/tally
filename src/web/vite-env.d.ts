interface ImportMetaEnv {
  /**
   * Dev only (`vite dev`); ignored by production builds. Set to serve every /api request from
   * the synthetic in-memory mock in src/web/mock instead of the local Worker.
   */
  readonly VITE_MOCK_API?: string;
}
