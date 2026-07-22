import { describe, expect, it } from 'vitest';
import {
  isAngularComponentMetadataPosition,
  shouldUseAngularInteractiveOverlay,
  shouldUseAngularInteractiveOverlayRange,
} from '../angular-overlay-routing.js';

function positionAt(content: string, needle: string, inside = 0): { line: number; column: number } {
  const offset = content.indexOf(needle) + inside;
  if (offset < inside) throw new Error(`missing test needle: ${needle}`);
  const before = content.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

const component = `
@Component({
  template: \`<button (click)="save()">{{ title }}</button>\`,
  styles: [\`.host { color: red }\`],
  templateUrl: './card.html',
  styleUrls: ['./card.css'],
})
export class CardComponent {}
const outside = 'ordinary typescript';
`;

describe('Angular overlay routing', () => {
  it('always routes HTML documents to the Angular overlay', () => {
    expect(shouldUseAngularInteractiveOverlay({
      projectId: 1,
      file: 'card.component.html',
      languageId: 'html',
      content: null,
      position: { line: 1, column: 1 },
    })).toBe(true);
  });

  it.each(['title', 'color', './card.html', './card.css'])(
    'routes TypeScript positions inside Component metadata string %s',
    (needle) => {
      expect(isAngularComponentMetadataPosition(
        '1:card.component.ts',
        'card.component.ts',
        component,
        positionAt(component, needle, 1),
      )).toBe(true);
    },
  );

  it('keeps ordinary TypeScript positions on the TypeScript service', () => {
    expect(shouldUseAngularInteractiveOverlay({
      projectId: 1,
      file: 'card.component.ts',
      languageId: 'typescript',
      content: component,
      position: positionAt(component, 'ordinary typescript', 2),
    })).toBe(false);
    expect(shouldUseAngularInteractiveOverlay({
      projectId: 1,
      file: 'card.component.ts',
      languageId: 'typescript',
      content: component,
      position: positionAt(component, 'template:', 1),
    })).toBe(false);
  });

  it('requires a real @Component decorator, not a similarly shaped call', () => {
    const source = `const metadata = Component({ template: '<x />' });`;
    expect(isAngularComponentMetadataPosition(
      '2:not-a-component.ts',
      'not-a-component.ts',
      source,
      positionAt(source, '<x />', 1),
    )).toBe(false);
  });

  it('recognizes an aliased Component import from @angular/core', () => {
    const source = `
import { Component as NgComponent } from '@angular/core';
@NgComponent({ template: '<app-child />' })
export class ParentComponent {}
`;
    expect(isAngularComponentMetadataPosition(
      '3:aliased.component.ts',
      'aliased.component.ts',
      source,
      positionAt(source, '<app-child />', 2),
    )).toBe(true);
  });

  it('recognizes a namespace Component import only when it comes from @angular/core', () => {
    const angularSource = `
import * as ng from '@angular/core';
@ng.Component({ template: '<app-child />' })
export class ParentComponent {}
`;
    expect(isAngularComponentMetadataPosition(
      '4:namespace.component.ts',
      'namespace.component.ts',
      angularSource,
      positionAt(angularSource, '<app-child />', 2),
    )).toBe(true);

    const unrelatedSource = `
import * as ui from '@example/ui';
@ui.Component({ template: '<not-angular />' })
export class OtherComponent {}
`;
    expect(isAngularComponentMetadataPosition(
      '5:unrelated.component.ts',
      'unrelated.component.ts',
      unrelatedSource,
      positionAt(unrelatedSource, '<not-angular />', 2),
    )).toBe(false);
  });

  it('routes a range that spans Angular metadata even when its endpoints are outside', () => {
    expect(shouldUseAngularInteractiveOverlayRange({
      projectId: 1,
      file: 'card.component.ts',
      languageId: 'typescript',
      content: component,
      range: {
        start: { line: 1, column: 1 },
        end: positionAt(component, 'export class', 1),
      },
    })).toBe(true);
    expect(shouldUseAngularInteractiveOverlayRange({
      projectId: 1,
      file: 'card.component.ts',
      languageId: 'typescript',
      content: component,
      range: {
        start: positionAt(component, 'ordinary typescript', 1),
        end: positionAt(component, 'ordinary typescript', 5),
      },
    })).toBe(false);
  });
});
