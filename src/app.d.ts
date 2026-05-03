/// <reference types="@sveltejs/kit" />

declare global {
  namespace App {
    interface Locals {
      sessionId?: string;
    }
  }
}

export {};
