import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { tiptapJsonToText } from '../src/drivers/yjs/yjs_driver.js';
import { createVersionMetadata, seqVersions } from '../src/versioning.js';

describe('versioning', () => {
  it('seqVersions retorna 1 pra lista vazia', () => {
    expect(seqVersions([])).toBe(1);
  });

  it('seqVersions incrementa o maior seq existente', () => {
    const versions = [
      { id: 'a', createdAt: '', createdBy: null, label: null, seq: 3 },
      { id: 'b', createdAt: '', createdBy: null, label: null, seq: 7 },
    ];
    expect(seqVersions(versions)).toBe(8);
  });

  it('createVersionMetadata gera id, timestamps e label', () => {
    const version = createVersionMetadata('user-1', 'primeira versão', 2);
    expect(version.id).toBeTruthy();
    expect(version.createdBy).toBe('user-1');
    expect(version.label).toBe('primeira versão');
    expect(version.seq).toBe(2);
    expect(new Date(version.createdAt).getTime()).not.toBeNaN();
  });
});

describe('tiptapJsonToText', () => {
  it('converte parágrafos com \\n\\n entre blocos', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Primeiro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Segundo' }] },
      ],
    };
    expect(tiptapJsonToText(json)).toBe('Primeiro\n\nSegundo');
  });

  it('concatena texto de nós inline (bold etc)', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'normal ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'negrito' },
          ],
        },
      ],
    };
    expect(tiptapJsonToText(json)).toBe('normal negrito');
  });

  it('retorna vazio pra doc vazio/null', () => {
    expect(tiptapJsonToText(null)).toBe('');
    expect(tiptapJsonToText({ type: 'doc', content: [] })).toBe('');
  });
});

describe('yjs roundtrip básico', () => {
  it('encode/apply update preserva o conteúdo', () => {
    const source = new Y.Doc();
    source.getText('content').insert(0, 'Olá colaboração');

    const state = Y.encodeStateAsUpdate(source);
    const target = new Y.Doc();
    Y.applyUpdate(target, state);

    expect(target.getText('content').toString()).toBe('Olá colaboração');
  });

  it('updates concorrentes fazem merge sem conflito', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();

    // Sync inicial: ambos no mesmo estado.
    const initial = Y.encodeStateAsUpdate(a);
    Y.applyUpdate(b, initial);

    // Edições concorrentes.
    a.getText('content').insert(0, 'AAA ');
    b.getText('content').insert(0, 'BBB ');

    // Sync bidirecional via updates diferenciais.
    const updateFromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const updateFromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(a, updateFromB);
    Y.applyUpdate(b, updateFromA);

    expect(a.getText('content').toString()).toBe(b.getText('content').toString());
    expect(a.getText('content').toString()).toContain('AAA');
    expect(a.getText('content').toString()).toContain('BBB');
  });

  it('state vector identifica o que falta sincronizar', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();

    a.getText('content').insert(0, 'local');
    // Com o vetor de b, encodeStateAsUpdate só manda o que b não tem.
    const diff = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    Y.applyUpdate(b, diff);

    expect(b.getText('content').toString()).toBe('local');
  });
});
