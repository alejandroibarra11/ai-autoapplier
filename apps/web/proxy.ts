import { NextResponse, type NextRequest } from 'next/server';
import { isAllowedHost } from '@autoapplier/core';

/** Rejects requests whose Host is not a loopback dashboard host (DNS-rebinding guard). */
export function proxy(req: NextRequest) {
  if (!isAllowedHost(req.headers.get('host'))) return new NextResponse('Forbidden', { status: 403 });
  return NextResponse.next();
}
