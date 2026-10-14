// The virtual module build.ts provides with the embedded web app (see src/web/assets.ts).
declare module "tcode:web-assets" {
  export const ASSETS: Record<string, string>;
}
