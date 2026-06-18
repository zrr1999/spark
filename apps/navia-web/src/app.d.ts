declare global {
  namespace App {
    interface Locals {
      requestId: string;
      sessionToken: string | null;
    }
  }
}

export {};
