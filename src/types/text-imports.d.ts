// src/types/text-imports.d.ts
declare module "*allowed_signers" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}
