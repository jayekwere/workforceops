import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { Id, Text, Fault, digest, equal } from './security.js';
import { boundedJson, fixedUrl } from './net.js';
const UserSchema = z.object({
  schemas: z.array(z.string()),
  id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
  externalId: Id,
  userName: z.email().max(160),
  displayName: Text,
  active: z.boolean(),
  roles: z.array(z.object({ value: Id })).max(20),
  meta: z.object({ resourceType: z.literal('User'), version: z.string().regex(/^W\/"\d+"$/) }),
});
export type ScimUser = z.infer<typeof UserSchema>;
export const DesiredSchema = z
  .object({
    externalId: Id,
    userName: z.email().max(160),
    displayName: Text,
    active: z.boolean(),
    roles: z.array(Id).max(20),
  })
  .strict();
export type Desired = z.infer<typeof DesiredSchema>;
export const project = (u: ScimUser): Desired => ({
  externalId: u.externalId,
  userName: u.userName,
  displayName: u.displayName,
  active: u.active,
  roles: u.roles.map((r) => r.value).sort(),
});
export interface ProviderConfig {
  alias: string;
  tenant: string;
  endpoint: string;
  token: string;
  mode: 'local-scim' | 'external-scim';
}
export class ScimClient {
  readonly base: URL;
  readonly fingerprint: string;
  constructor(
    readonly config: ProviderConfig,
    allowLocal = false,
    private fetcher = fetch,
  ) {
    this.base = fixedUrl(config.endpoint, allowLocal);
    this.fingerprint = digest({
      alias: config.alias,
      tenant: config.tenant,
      endpoint: this.base.href,
      mode: config.mode,
    });
  }
  private url(suffix: string) {
    return new URL(this.base.href.replace(/\/$/, '') + suffix);
  }
  private async call(suffix: string, method = 'GET', body?: unknown, etag?: string) {
    return boundedJson(this.url(suffix), {
      method,
      ...(body !== undefined ? { body } : {}),
      headers: {
        authorization: 'Bearer ' + this.config.token,
        ...(etag ? { 'if-match': etag } : {}),
      },
      fetcher: this.fetcher,
    });
  }
  async list(): Promise<ScimUser[]> {
    const { data } = await this.call('/Users?startIndex=1&count=200');
    const page = z
      .object({
        totalResults: z.number().int().min(0).max(200),
        Resources: z.array(UserSchema).max(200),
      })
      .parse(data);
    if (page.totalResults !== page.Resources.length)
      throw new Fault(502, 'incomplete_scim_inventory');
    return page.Resources;
  }
  async find(externalId: string) {
    const u = this.url('/Users');
    u.searchParams.set('filter', `externalId eq "${Id.parse(externalId)}"`);
    const { data } = await boundedJson(u, {
      headers: { authorization: 'Bearer ' + this.config.token },
      fetcher: this.fetcher,
    });
    const page = z
      .object({
        totalResults: z.number().int().min(0).max(1),
        Resources: z.array(UserSchema).max(1),
      })
      .parse(data);
    if (page.Resources.length !== page.totalResults) throw new Fault(502, 'scim_contract_invalid');
    const user = page.Resources[0];
    if (user && user.externalId !== externalId) throw new Fault(502, 'scim_identity_mismatch');
    return user ?? null;
  }
  async write(desired: Desired, before: ScimUser | null) {
    const payload = {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      ...desired,
      roles: desired.roles.map((value) => ({ value })),
    };
    const response = before
      ? await this.call(
          '/Users/' + encodeURIComponent(before.id),
          'PATCH',
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [
              { op: 'replace', path: 'active', value: desired.active },
              { op: 'replace', path: 'displayName', value: desired.displayName },
              { op: 'replace', path: 'roles', value: payload.roles },
            ],
          },
          before.meta.version,
        )
      : await this.call('/Users', 'POST', payload);
    return UserSchema.parse(response.data);
  }
}
export interface LabFault {
  unavailable: boolean;
  loseAcknowledgement: boolean;
}
export function createScimLab(store: Store, tokens: Record<string, string>) {
  const faults: Record<string, LabFault> = {
    directory: { unavailable: false, loseAcknowledgement: false },
    collaboration: { unavailable: false, loseAcknowledgement: false },
  };
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  app.addHook('onRequest', async (req, reply) => {
    const alias = req.url.split('/')[1] ?? '';
    if (!tokens[alias] || !equal(req.headers.authorization ?? '', 'Bearer ' + tokens[alias]))
      return reply.status(401).send({ detail: 'Unauthorized' });
    if (faults[alias]?.unavailable)
      return reply.status(503).send({ detail: 'Lab service unavailable' });
  });
  app.setErrorHandler((_e, _req, reply) =>
    reply.status(400).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      detail: 'Invalid SCIM request',
    }),
  );
  app.get('/:provider/scim/v2/ServiceProviderConfig', async () => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    filter: { supported: true, maxResults: 200 },
    etag: { supported: true },
    bulk: { supported: false },
    sort: { supported: false },
    changePassword: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'Dedicated local lab credential',
      },
    ],
  }));
  app.get('/:provider/scim/v2/Users', async (req) => {
    const { provider } = z
      .object({ provider: z.enum(['directory', 'collaboration']) })
      .parse(req.params);
    const query = z
      .object({
        filter: z.string().optional(),
        startIndex: z.string().optional(),
        count: z.string().optional(),
      })
      .parse(req.query);
    let users = store.list<ScimUser>(provider, 'user', 200);
    if (query.filter) {
      const m = /^externalId eq "([a-z0-9-]{1,64})"$/.exec(query.filter);
      if (!m) throw new Error('Unsupported filter');
      users = users.filter((u) => u.externalId === m[1]);
    }
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: users.length,
      startIndex: 1,
      itemsPerPage: users.length,
      Resources: users,
    };
  });
  app.post('/:provider/scim/v2/Users', async (req, reply) => {
    const { provider } = z
      .object({ provider: z.enum(['directory', 'collaboration']) })
      .parse(req.params);
    const raw = z
      .object({
        schemas: z.array(z.string()),
        externalId: Id,
        userName: z.email(),
        displayName: Text,
        active: z.boolean(),
        roles: z.array(z.object({ value: Id })),
      })
      .strict()
      .parse(req.body);
    return store.tx(() => {
      if (
        store
          .list<ScimUser>(provider, 'user')
          .some((u) => u.externalId === raw.externalId || u.userName === raw.userName)
      )
        return reply.status(409).send({ detail: 'Conflict' });
      const user: ScimUser = {
        ...raw,
        id: randomUUID(),
        meta: { resourceType: 'User', version: 'W/"1"' },
      };
      store.put(provider, 'user', user.id, user);
      store.put(provider, 'writes', 'count', {
        n: (store.get<{ n: number }>(provider, 'writes', 'count')?.n ?? 0) + 1,
      });
      return reply.status(201).header('etag', user.meta.version).send(user);
    });
  });
  app.patch('/:provider/scim/v2/Users/:id', async (req, reply) => {
    const { provider, id } = z
      .object({ provider: z.enum(['directory', 'collaboration']), id: z.string().uuid() })
      .parse(req.params);
    const body = z
      .object({
        schemas: z.array(z.string()),
        Operations: z
          .array(
            z
              .object({
                op: z.literal('replace'),
                path: z.enum(['active', 'displayName', 'roles']),
                value: z.unknown(),
              })
              .strict(),
          )
          .min(1)
          .max(3),
      })
      .strict()
      .parse(req.body);
    return store.tx(() => {
      const user = store.need<ScimUser>(provider, 'user', id);
      if (req.headers['if-match'] !== user.meta.version)
        return reply.status(412).send({ detail: 'Version conflict' });
      for (const op of body.Operations) {
        if (op.path === 'active') user.active = z.boolean().parse(op.value);
        if (op.path === 'displayName') user.displayName = Text.parse(op.value);
        if (op.path === 'roles')
          user.roles = z
            .array(z.object({ value: Id }).strict())
            .max(20)
            .parse(op.value);
      }
      user.meta.version = `W/"${Number(user.meta.version.match(/\d+/)![0]) + 1}"`;
      store.put(provider, 'user', id, user);
      store.put(provider, 'writes', 'count', {
        n: (store.get<{ n: number }>(provider, 'writes', 'count')?.n ?? 0) + 1,
      });
      if (faults[provider]!.loseAcknowledgement)
        return reply.status(503).send({ detail: 'Lab acknowledgement lost after commit' });
      return reply.header('etag', user.meta.version).send(user);
    });
  });
  return {
    app,
    faults,
    seed(provider: string, desired: Desired) {
      const user: ScimUser = {
        ...desired,
        id: randomUUID(),
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        roles: desired.roles.map((value) => ({ value })),
        meta: { resourceType: 'User', version: 'W/"1"' },
      };
      store.put(provider, 'user', user.id, user);
      return user;
    },
  };
}
