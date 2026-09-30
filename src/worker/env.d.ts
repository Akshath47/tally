// Vite replaces these at build time; declared here so Worker code needn't pull in DOM-based vite/client types.
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
