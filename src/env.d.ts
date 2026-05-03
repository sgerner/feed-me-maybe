/// <reference types="@sveltejs/kit" />

declare module '$env/dynamic/private' {
  export const env: Record<string, string | undefined>;
}

declare module '$env/dynamic/public' {
  export const env: Record<string, string | undefined>;
}
