// @vitest-environment node
import 'fake-indexeddb/auto';

import { afterAll, describe, expect, it } from 'vitest';

import { createProjectForOrigin, getDatabase } from '../src/lib/projects/db';
import { normalizeProjectOrigin } from '../src/lib/projects/origin';

describe('project website address', () => {
  afterAll(async () => {
    (await getDatabase()).close();
    indexedDB.deleteDatabase('seo-opt-workbench');
  });

  it.each([
    ['relebook.com', 'https://relebook.com'],
    ['www.relebook.com', 'https://www.relebook.com'],
    ['https://relebook.com/path?source=test#section', 'https://relebook.com'],
    ['relebook.com:8080/path', 'https://relebook.com:8080'],
    ['localhost:3000/debug', 'https://localhost:3000'],
    ['http://localhost:3000/debug', 'http://localhost:3000'],
  ])('normalizes %s to a site origin', (input, expected) => {
    expect(normalizeProjectOrigin(input)).toBe(expected);
  });

  it.each(['', 'not a website', 'chrome://extensions', 'ftp://example.com', 'https:example.com', 'https://user:pass@example.com'])('rejects unsupported input %j', (input) => {
    expect(() => normalizeProjectOrigin(input)).toThrow();
  });

  it('returns the existing project for the same normalized origin', async () => {
    const first = await createProjectForOrigin('relebook.com');
    const second = await createProjectForOrigin('https://relebook.com/path');
    expect(second.id).toBe(first.id);
    expect(second.origin).toBe('https://relebook.com');
  });

  it('creates only one internal record when the same site initializes concurrently', async () => {
    const projects = await Promise.all(
      Array.from({ length: 8 }, () => createProjectForOrigin('https://concurrent.example/path')),
    );
    expect(new Set(projects.map((project) => project.id)).size).toBe(1);
    const stored = await (await getDatabase()).getAllFromIndex('projects', 'by-origin', 'https://concurrent.example');
    expect(stored).toHaveLength(1);
  });
});
