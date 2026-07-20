declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
      requestId?: string;
    }

    interface Locals {
      requestId: string;
      sessionToken: string | null;
      workspaceSessionToken: string | null;
      workspaceId: string | null;
    }
  }
}

export {};
