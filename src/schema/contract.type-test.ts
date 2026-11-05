// Type-level test of the derived contract types (checked by `tsc`, never imported or bundled): the
// schemas must produce the shapes the readers rely on. A schema edit that changes one of these
// fails the typecheck here instead of somewhere in a reader.

import type {
  Layout, LayoutFloor, LayoutModel, LayoutMower, LayoutObject, LayoutPin, LayoutRoom, LayoutTag, LayoutView,
  MowerOverlay, PlanPoint, SavedLevelBinding, Vec3, WashDir,
} from '../types/layout.ts';
import type { CardConfig, RenderCardOption, ResolvedCardConfig } from '../types/config.ts';
import type { Infer, Schema } from './core.ts';
import { literal, number, object, optional, string, withDefault } from './core.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
/** K is an optional key of T. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

export type Checks = [
  // the parsed layout: the lists and maps every reader uses are present
  Expect<Equal<Layout['version'], number>>,
  Expect<Equal<Layout['floors'], LayoutFloor[]>>,
  Expect<Equal<Layout['rooms'], LayoutRoom[]>>,
  Expect<Equal<Layout['pins'], Record<string, LayoutPin>>>,
  Expect<Equal<Layout['hidden'], string[]>>,
  Expect<Equal<Layout['mower'], LayoutMower | null>>,
  Expect<Equal<Layout['model'], LayoutModel | null>>,
  Expect<IsOptional<Layout, 'objects'>>,
  Expect<Equal<NonNullable<Layout['objects']>, Record<string, LayoutObject>>>,
  Expect<Equal<NonNullable<Layout['tags']>, Record<string, LayoutTag>>>,
  Expect<Equal<NonNullable<Layout['views']>, Record<string, LayoutView>>>,
  Expect<Equal<Layout['room_labels'], 'size' | 'name' | 'none' | undefined>>,
  Expect<Equal<Layout['tap_hints'], 'near' | 'always' | 'off' | undefined>>,
  // unknown fields are kept: every stored object has an index signature
  Expect<Equal<Layout['some_future_field'], unknown>>,
  Expect<Equal<LayoutRoom['walls'], unknown>>,
  // rooms and pins
  Expect<Equal<LayoutRoom['id'], string>>,
  Expect<Equal<LayoutRoom['polygon'], PlanPoint[]>>,
  Expect<Equal<LayoutRoom['doors'], PlanPoint[] | undefined>>,
  Expect<Equal<LayoutRoom['area_id'], string | null | undefined>>,
  Expect<Equal<LayoutPin['x'], number>>,
  Expect<Equal<LayoutPin['z'], number | undefined>>,
  Expect<Equal<LayoutPin['offset'], Vec3 | undefined>>,
  Expect<IsOptional<LayoutPin, 'z'>>,
  Expect<Equal<IsOptional<LayoutPin, 'x'>, false>>,
  // model, mower, objects
  Expect<Equal<LayoutModel['position'], Vec3 | undefined>>,
  Expect<Equal<NonNullable<LayoutModel['levels']>, Record<string, SavedLevelBinding>>>,
  Expect<Equal<SavedLevelBinding['floor'], string | null | undefined>>,
  Expect<Equal<LayoutMower['overlay'], MowerOverlay | null | undefined>>,
  Expect<Equal<LayoutMower['stuck_minutes'], number | undefined>>,
  Expect<Equal<MowerOverlay['bg_colors'], number[][] | undefined>>,
  Expect<Equal<LayoutObject['entity'], string | null | undefined>>,
  Expect<Equal<LayoutObject['wash'], WashDir | undefined>>,
  // card config: the defaults are applied, the YAML type keeps every option optional
  Expect<Equal<ResolvedCardConfig['layout_key'], string>>,
  Expect<Equal<ResolvedCardConfig['height'], string>>,
  Expect<Equal<ResolvedCardConfig['group_by'], 'device' | 'entity'>>,
  Expect<Equal<ResolvedCardConfig['wall_height'], number>>,
  Expect<Equal<ResolvedCardConfig['view'], '3d' | 'top'>>,
  Expect<Equal<ResolvedCardConfig['render'], RenderCardOption | undefined>>,
  Expect<Equal<ResolvedCardConfig['model_rotation'], number | undefined>>,
  Expect<IsOptional<CardConfig, 'layout_key'>>,
  Expect<Equal<CardConfig['type'], string>>,
  // the combinators themselves
  Expect<Equal<Infer<Schema<string>>, string>>,
  Expect<Equal<Sample['a'], string>>,
  Expect<Equal<IsOptional<Sample, 'a'>, false>>,
  Expect<IsOptional<Sample, 'b'>>,
  Expect<Equal<Sample['b'], number | undefined>>,
  Expect<Equal<Sample['c'], 'x' | 'y'>>,
  Expect<Equal<IsOptional<Sample, 'c'>, false>>, // withDefault: always present after parsing
];

type Sample = Infer<ReturnType<typeof sample>>;
const sample = () => object({ a: string(), b: optional(number()), c: withDefault(literal('x', 'y'), () => 'x' as const) });
