import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../backend/src/uploads/create-upload', () => ({
  handler: vi.fn(),
}));

import { handler as createUpload } from '../../backend/src/uploads/create-upload';
import { handler } from '../../backend/src/uploads/reporter-upload';

function event(purpose: string): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify({
      purpose,
      contentType: 'image/jpeg',
      sizeBytes: 100,
    }),
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1' },
  } as APIGatewayProxyEventV2;
}

describe('reporter-only upload deployment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('passes defect uploads to the normal validated handler', async () => {
    vi.mocked(createUpload).mockResolvedValue({ statusCode: 201 });
    const request = event('DEFECT');

    expect((await handler(request)).statusCode).toBe(201);
    expect(createUpload).toHaveBeenCalledWith(request);
  });

  it('closes repair-proof uploads until staff authentication is deployed', async () => {
    const response = await handler(event('REPAIR_PROOF'));

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body ?? '').error).toMatchObject({
      code: 'FORBIDDEN',
      requestId: 'req-1',
    });
    expect(createUpload).not.toHaveBeenCalled();
  });
});
