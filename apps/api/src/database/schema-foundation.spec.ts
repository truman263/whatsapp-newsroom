import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repositoryRoot = resolve(process.cwd(), '../..');
const schema = readFileSync(resolve(repositoryRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'prisma/migrations/00000000000000_round_1_2_baseline/migration.sql',
  ),
  'utf8',
);

describe('Round 1 persistence schema', () => {
  it.each([
    'Reporter',
    'Conversation',
    'InboundEvent',
    'OutboundMessage',
    'Story',
    'StoryMedia',
    'Approval',
    'PublishAttempt',
    'AuditLog',
  ])('defines the %s model', (model) => {
    expect(schema).toContain(`model ${model} {`);
  });

  it.each([
    'Reporter_phoneNumber_key',
    'Conversation_reporterId_key',
    'InboundEvent_provider_providerMessageId_key',
    'OutboundMessage_correlationKey_key',
    'Story_wordpressPostId_key',
    'StoryMedia_providerMediaId_key',
    'StoryMedia_storyId_position_key',
    'Approval_storyId_key',
    'Approval_inboundEventId_key',
    'PublishAttempt_idempotencyKey_key',
    'PublishAttempt_storyId_operation_attemptNumber_key',
  ])('generates the %s database uniqueness boundary', (constraint) => {
    expect(migration).toContain(`CREATE UNIQUE INDEX "${constraint}"`);
  });

  it('uses evidence-preserving referential actions', () => {
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).toContain('ON DELETE SET NULL');
  });

  it('contains the manually reviewed numeric check constraints', () => {
    expect(migration).toContain('"Conversation_version_nonnegative"');
    expect(migration).toContain('"InboundEvent_processingAttempts_nonnegative"');
    expect(migration).toContain('"OutboundMessage_sendAttempts_nonnegative"');
    expect(migration).toContain('"Story_version_nonnegative"');
    expect(migration).toContain('"StoryMedia_position_nonnegative"');
    expect(migration).toContain('"PublishAttempt_attemptNumber_positive"');
  });

  it('does not persist deployment secrets', () => {
    expect(schema).not.toMatch(
      /WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET|WORDPRESS_APPLICATION_PASSWORD|Authorization/i,
    );
  });
});
