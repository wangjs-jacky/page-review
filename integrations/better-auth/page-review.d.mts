import type { Request, Response, NextFunction } from 'express';
export function createPageReviewBridge(options: {
  getIdentity(req: Request): Promise<{ user: {id: string; name: string}; session: {id: string; expiresAt: Date | string} } | null>;
  readConfig(): {apiOrigin: string; key: string} | null;
  loginOrigin: string;
  layout(title: string, content: string, script?: string): string;
  fetcher?: typeof fetch;
}): (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
