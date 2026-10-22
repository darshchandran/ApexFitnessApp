// APEX's food table: common, affordable foods in Indian kitchens, per 100 g (or 100 ml for drinks).
//
// Provenance: approximate, rounded values in line with common food-composition references (USDA
// FoodData Central, the Indian Food Composition Tables) — "reference" — or estimates for a typical
// home-style recipe of a dish — "recipe". Neither is lab-verified for a brand or a kitchen: real
// foods vary, so every number APEX shows from here is an estimate. Fix or extend values here; logged
// entries keep the numbers they were logged with.
//
// Diet: non-vegetarian, never beef — no beef item exists, and nothing here needs supplements.

export interface Food {
  id: string;
  name: string;
  /** Other names the athlete may type (Hindi names, plurals). */
  aliases?: string[];
  per100: { kcal: number; protein: number; carbs: number; fat: number };
  /** Grams (ml for drinks), always available. */
  base: 'g' | 'ml';
  /** Household units with their weight; the first is how a serving is counted. */
  units: { unit: string; grams: number }[];
  /** A usual serving, in the first unit. */
  serve: number;
  /** 1 = budget, 2 = moderate. */
  cost: 1 | 2;
  tags: FoodTag[];
  source: 'reference' | 'recipe';
}

export type FoodTag = 'protein' | 'carb' | 'fat' | 'dairy' | 'egg' | 'chicken' | 'fish' | 'veg' | 'fruit' | 'quick';

export const FOOD_DATA_NOTE =
  'Estimates: rounded values in line with common food-composition references (e.g. USDA FoodData Central, Indian Food Composition Tables); home-style dishes are recipe estimates. Real portions and recipes vary.';

const f = (
  id: string, name: string, [kcal, protein, carbs, fat]: [number, number, number, number],
  units: Food['units'], serve: number, tags: FoodTag[], o: { aliases?: string[]; base?: 'g' | 'ml'; cost?: 1 | 2; source?: Food['source'] } = {},
): Food => ({ id, name, per100: { kcal, protein, carbs, fat }, units, serve, tags, base: o.base ?? 'g', cost: o.cost ?? 1, source: o.source ?? 'reference', ...(o.aliases && { aliases: o.aliases }) });

const G = [{ unit: 'g', grams: 1 }];
const KATORI = (g = 150) => [{ unit: 'katori', grams: g }, ...G];
const ML = [{ unit: 'ml', grams: 1 }];

export const FOODS: Food[] = [
  // eggs, meat, fish
  f('egg', 'Egg (whole)', [143, 12.6, 0.7, 9.5], [{ unit: 'egg', grams: 50 }, ...G], 2, ['protein', 'egg'], { aliases: ['eggs', 'anda', 'boiled egg', 'omelette'] }),
  f('egg-white', 'Egg white', [52, 10.9, 0.7, 0.2], [{ unit: 'white', grams: 33 }, ...G], 3, ['protein', 'egg']),
  f('chicken-breast', 'Chicken breast, cooked', [165, 31, 0, 3.6], G, 120, ['protein', 'chicken'], { aliases: ['chicken', 'grilled chicken'], cost: 2 }),
  f('chicken-curry', 'Chicken curry (home-style)', [150, 14, 4, 8.7], KATORI(), 1, ['protein', 'chicken'], { aliases: ['chicken gravy'], cost: 2, source: 'recipe' }),
  f('fish', 'Fish, cooked (rohu, basa)', [120, 22, 0, 3.5], G, 120, ['protein', 'fish'], { aliases: ['rohu', 'basa'], cost: 2 }),
  f('fish-curry', 'Fish curry (home-style)', [128, 13, 3, 7], KATORI(), 1, ['protein', 'fish'], { aliases: ['machli', 'macher jhol'], cost: 2, source: 'recipe' }),
  f('chicken-biryani', 'Chicken biryani', [190, 9, 23, 7], [{ unit: 'plate', grams: 300 }, ...G], 1, ['protein', 'carb', 'chicken'], { aliases: ['biryani'], cost: 2, source: 'recipe' }),
  // dairy
  f('milk-toned', 'Milk, toned', [58, 3.1, 4.7, 3.0], [{ unit: 'glass', grams: 250 }, ...ML], 1, ['dairy', 'protein'], { base: 'ml', aliases: ['milk', 'doodh'] }),
  f('milk-full', 'Milk, full-cream', [86, 3.2, 4.9, 6.0], [{ unit: 'glass', grams: 250 }, ...ML], 1, ['dairy', 'fat'], { base: 'ml', aliases: ['whole milk'] }),
  f('curd', 'Curd (dahi)', [61, 3.5, 4.7, 3.3], KATORI(), 1, ['dairy', 'protein'], { aliases: ['dahi', 'yogurt', 'yoghurt'] }),
  f('buttermilk', 'Buttermilk (chaas)', [25, 1.5, 2.2, 1.1], [{ unit: 'glass', grams: 250 }, ...ML], 1, ['dairy'], { base: 'ml', aliases: ['chaas', 'chhaas'], source: 'recipe' }),
  f('paneer', 'Paneer', [265, 18, 1.2, 21], G, 100, ['protein', 'dairy', 'fat'], { aliases: ['cottage cheese'], cost: 2 }),
  // grains and breads
  f('rice', 'Rice, cooked', [130, 2.7, 28.2, 0.3], [{ unit: 'bowl', grams: 150 }, ...G], 1, ['carb'], { aliases: ['chawal', 'white rice'] }),
  f('roti', 'Roti / chapati', [275, 8.7, 47.5, 6.2], [{ unit: 'roti', grams: 40 }, ...G], 2, ['carb'], { aliases: ['chapati', 'phulka', 'rotis'], source: 'recipe' }),
  f('paratha', 'Paratha (plain)', [300, 7, 42, 12], [{ unit: 'paratha', grams: 80 }, ...G], 1, ['carb', 'fat'], { source: 'recipe' }),
  f('oats', 'Oats (dry)', [379, 13, 68, 6.5], G, 50, ['carb'], { aliases: ['oatmeal', 'rolled oats'] }),
  f('bread', 'Bread, whole wheat', [250, 12.5, 43, 3.5], [{ unit: 'slice', grams: 28 }, ...G], 2, ['carb', 'quick'], { aliases: ['toast', 'brown bread'] }),
  f('poha', 'Poha (cooked)', [140, 2.8, 24, 3.7], [{ unit: 'plate', grams: 200 }, ...G], 1, ['carb'], { source: 'recipe' }),
  f('upma', 'Upma', [130, 3, 19, 4.5], [{ unit: 'plate', grams: 200 }, ...G], 1, ['carb'], { source: 'recipe' }),
  f('idli', 'Idli', [146, 4.5, 30, 1], [{ unit: 'idli', grams: 40 }, ...G], 3, ['carb'], { aliases: ['idlis'], source: 'recipe' }),
  f('dosa', 'Dosa (plain)', [168, 4, 25, 5.6], [{ unit: 'dosa', grams: 80 }, ...G], 2, ['carb'], { source: 'recipe' }),
  f('sambar', 'Sambar', [65, 3, 9, 2], KATORI(), 1, ['protein', 'veg'], { source: 'recipe' }),
  f('khichdi', 'Khichdi (moong dal & rice)', [120, 4.5, 20, 2.5], [{ unit: 'bowl', grams: 250 }, ...G], 1, ['carb', 'protein'], { source: 'recipe' }),
  // pulses and legumes
  f('dal', 'Dal (cooked, home-style)', [110, 6.5, 15, 2.8], KATORI(), 1, ['protein', 'carb'], { aliases: ['daal', 'toor dal', 'moong dal', 'masoor dal', 'lentils'], source: 'recipe' }),
  f('rajma', 'Rajma (curry)', [140, 6, 18, 4.5], KATORI(), 1, ['protein', 'carb'], { aliases: ['kidney beans'], source: 'recipe' }),
  f('chole', 'Chole (curry)', [150, 6.5, 19, 5.2], KATORI(), 1, ['protein', 'carb'], { aliases: ['chana masala', 'chickpeas'], source: 'recipe' }),
  f('soya-chunks', 'Soya chunks (dry weight)', [345, 52, 33, 0.5], G, 40, ['protein'], { aliases: ['soya', 'soy chunks', 'nutrela'] }),
  f('sprouts', 'Moong sprouts', [30, 3, 4.2, 0.2], [{ unit: 'bowl', grams: 150 }, ...G], 1, ['protein', 'veg'], { aliases: ['sprouts salad'] }),
  f('roasted-chana', 'Roasted chana', [369, 22, 58, 5.2], [{ unit: 'handful', grams: 30 }, ...G], 1, ['protein', 'carb', 'quick'], { aliases: ['chana', 'bhuna chana', 'roasted gram'] }),
  f('sattu', 'Sattu (roasted gram flour)', [406, 20.6, 65, 7], G, 40, ['protein', 'carb'], { aliases: ['sattu drink'] }),
  // nuts, fats, sweeteners
  f('peanuts', 'Peanuts, roasted', [585, 24, 21, 50], [{ unit: 'handful', grams: 30 }, ...G], 1, ['fat', 'protein', 'quick'], { aliases: ['moongphali', 'groundnuts'] }),
  f('peanut-butter', 'Peanut butter', [588, 25, 20, 50], [{ unit: 'tbsp', grams: 16 }, ...G], 1, ['fat', 'protein'], { cost: 2 }),
  f('almonds', 'Almonds', [579, 21, 22, 50], [{ unit: 'handful', grams: 20 }, ...G], 1, ['fat'], { aliases: ['badam'], cost: 2 }),
  f('ghee', 'Ghee', [900, 0, 0, 100], [{ unit: 'tsp', grams: 5 }, ...G], 1, ['fat']),
  f('oil', 'Cooking oil', [884, 0, 0, 100], [{ unit: 'tsp', grams: 5 }, ...G], 1, ['fat'], { aliases: ['oil'] }),
  f('honey', 'Honey', [304, 0.3, 82, 0], [{ unit: 'tsp', grams: 7 }, ...G], 1, ['carb', 'quick']),
  // vegetables, fruit
  f('sabzi', 'Mixed vegetable sabzi', [90, 2.5, 9, 5], KATORI(), 1, ['veg'], { aliases: ['sabji', 'vegetables', 'bhaji'], source: 'recipe' }),
  f('salad', 'Salad (cucumber, tomato, onion)', [20, 0.9, 4, 0.2], [{ unit: 'bowl', grams: 100 }, ...G], 1, ['veg']),
  f('potato', 'Potato, boiled', [87, 1.9, 20.1, 0.1], [{ unit: 'potato', grams: 150 }, ...G], 1, ['carb', 'veg'], { aliases: ['aloo', 'potatoes'] }),
  f('sweet-potato', 'Sweet potato, boiled', [76, 1.4, 17.7, 0.1], [{ unit: 'potato', grams: 150 }, ...G], 1, ['carb', 'veg'], { aliases: ['shakarkandi'] }),
  f('banana', 'Banana', [89, 1.1, 22.8, 0.3], [{ unit: 'banana', grams: 118 }, ...G], 1, ['fruit', 'carb', 'quick'], { aliases: ['kela', 'bananas'] }),
  f('apple', 'Apple', [52, 0.3, 12.5, 0.2], [{ unit: 'apple', grams: 180 }, ...G], 1, ['fruit'], { aliases: ['seb'] }),
  f('orange', 'Orange', [47, 0.9, 11.8, 0.1], [{ unit: 'orange', grams: 130 }, ...G], 1, ['fruit'], { aliases: ['santra'] }),
  f('dates', 'Dates', [282, 2.5, 68, 0.4], [{ unit: 'date', grams: 8 }, ...G], 3, ['fruit', 'carb', 'quick'], { aliases: ['khajur'] }),
];

const BY_ID = new Map(FOODS.map((x) => [x.id, x]));
export const foodById = (id: string) => BY_ID.get(id);

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Foods matching what the athlete typed: names and aliases, every word present; exact matches first. */
export function searchFoods(query: string, limit = 20): Food[] {
  const q = norm(query);
  if (!q) return FOODS.slice(0, limit);
  const words = q.split(' ');
  const scored = FOODS.flatMap((x) => {
    const names = [x.name, ...(x.aliases ?? [])].map(norm);
    if (names.some((n) => n === q)) return [{ x, s: 0 }];
    if (names.some((n) => n.startsWith(q))) return [{ x, s: 1 }];
    if (names.some((n) => words.every((w) => n.includes(w)))) return [{ x, s: 2 }];
    return [];
  });
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((r) => r.x);
}

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
const r1 = (n: number) => Math.round(n * 10) / 10;
export const addMacros = (a: Macros, b: Macros): Macros => ({ kcal: a.kcal + b.kcal, protein: r1(a.protein + b.protein), carbs: r1(a.carbs + b.carbs), fat: r1(a.fat + b.fat) });

/** Grams (or ml) for a quantity in one of the food's units. */
export function gramsOf(food: Food, qty: number, unit = food.units[0].unit) {
  const u = food.units.find((x) => x.unit === unit) ?? (unit === food.base ? { grams: 1 } : undefined);
  return u ? qty * u.grams : undefined;
}

/** Macros for a quantity of a food: kcal to the whole number, grams of macros to 0.1. */
export function macrosOf(food: Food, grams: number): Macros {
  const k = grams / 100;
  return { kcal: Math.round(food.per100.kcal * k), protein: r1(food.per100.protein * k), carbs: r1(food.per100.carbs * k), fat: r1(food.per100.fat * k) };
}

/** "2 eggs", "150 g", "1 katori" — a quantity in words. */
export function amountText(qty: number, unit: string) {
  const n = +qty.toFixed(2);
  if (unit === 'g' || unit === 'ml') return `${n} ${unit}`;
  const plural = n <= 1 ? unit : unit.endsWith('s') ? unit : unit === 'katori' ? 'katoris' : `${unit}s`;
  return `${n} ${plural}`;
}

// ---------- meal templates (suggestions only — nothing counts as eaten until it is logged) ----------

export type MealSlot = 'breakfast' | 'lunch' | 'snacks' | 'dinner' | 'preGym';
export type PreGymWindow = 'under45' | '1to2h' | '2to3h';

export interface MealTemplate {
  id: string;
  slot: MealSlot;
  name: string;
  /** [food id, quantity in the food's first unit]. */
  items: [string, number][];
  /** After basketball: carbs and protein for recovery. */
  recovery?: boolean;
  /** Pre-gym: how long before training it suits. */
  window?: PreGymWindow;
}

const m = (id: string, slot: MealSlot, name: string, items: [string, number][], o: { recovery?: boolean; window?: PreGymWindow } = {}): MealTemplate => ({ id, slot, name, items, ...o });

export const MEALS: MealTemplate[] = [
  m('b-oats', 'breakfast', 'Oats with milk, banana & boiled eggs', [['oats', 50], ['milk-toned', 1], ['banana', 1], ['egg', 2]]),
  m('b-bhurji', 'breakfast', 'Egg bhurji with roti & milk', [['egg', 3], ['oil', 1], ['roti', 2], ['milk-toned', 1]]),
  m('b-poha', 'breakfast', 'Poha with boiled eggs & curd', [['poha', 1], ['egg', 2], ['curd', 1]]),
  m('b-idli', 'breakfast', 'Idli, sambar & boiled eggs', [['idli', 4], ['sambar', 1], ['egg', 2]]),
  m('b-toast', 'breakfast', 'Peanut-butter toast, milk & banana', [['bread', 3], ['peanut-butter', 2], ['milk-toned', 1], ['banana', 1]]),

  m('l-chicken', 'lunch', 'Chicken curry, rice & dal', [['rice', 1.5], ['chicken-curry', 1], ['dal', 1], ['salad', 1]]),
  m('l-dal-roti', 'lunch', 'Dal, roti, sabzi & curd', [['roti', 3], ['dal', 1.5], ['sabzi', 1], ['curd', 1]]),
  m('l-soya', 'lunch', 'Soya chunks curry with roti & curd', [['soya-chunks', 40], ['sabzi', 1], ['roti', 3], ['curd', 1]]),
  m('l-rajma', 'lunch', 'Rajma chawal with curd & eggs', [['rice', 1.5], ['rajma', 1], ['curd', 1], ['egg', 1]]),
  m('l-fish', 'lunch', 'Fish curry, rice & sabzi', [['rice', 1.5], ['fish-curry', 1.5], ['sabzi', 1]]),

  m('s-chana', 'snacks', 'Roasted chana & banana', [['roasted-chana', 1.5], ['banana', 1]]),
  m('s-peanut-milk', 'snacks', 'Peanuts & a glass of milk', [['peanuts', 1], ['milk-toned', 1]]),
  m('s-eggs', 'snacks', 'Boiled eggs & fruit', [['egg', 2], ['apple', 1]]),
  m('s-curd', 'snacks', 'Curd with banana & peanuts', [['curd', 1.5], ['banana', 1], ['peanuts', 0.5]]),
  m('s-milk-toast', 'snacks', 'Milk, banana & peanut-butter toast', [['milk-toned', 1], ['banana', 1], ['bread', 1], ['peanut-butter', 1]], { recovery: true }),
  m('s-sattu', 'snacks', 'Sattu drink & banana', [['sattu', 40], ['banana', 1]], { recovery: true }),
  m('s-curd-rice', 'snacks', 'Curd rice', [['rice', 1], ['curd', 1]], { recovery: true }),

  m('d-chicken', 'dinner', 'Chicken, roti & sabzi', [['chicken-breast', 120], ['roti', 3], ['sabzi', 1]]),
  m('d-egg-curry', 'dinner', 'Egg curry with rice', [['egg', 3], ['oil', 1], ['sabzi', 1], ['rice', 1.5]]),
  m('d-paneer', 'dinner', 'Paneer bhurji with roti & salad', [['paneer', 100], ['roti', 3], ['salad', 1]]),
  m('d-khichdi', 'dinner', 'Khichdi with curd & eggs', [['khichdi', 1.2], ['curd', 1], ['egg', 2]]),
  m('d-fish', 'dinner', 'Fish with rice & dal', [['fish', 120], ['rice', 1.2], ['dal', 1]]),

  m('p-banana-dates', 'preGym', 'Banana & dates', [['banana', 1], ['dates', 3]], { window: 'under45' }),
  m('p-honey-toast', 'preGym', 'Toast with honey', [['bread', 2], ['honey', 1]], { window: 'under45' }),
  m('p-curd-oats', 'preGym', 'Curd, banana & oats', [['curd', 1], ['banana', 1], ['oats', 30]], { window: '1to2h' }),
  m('p-pb-toast', 'preGym', 'Peanut-butter toast & banana', [['bread', 2], ['peanut-butter', 1], ['banana', 1]], { window: '1to2h' }),
  m('p-rice-dal', 'preGym', 'Rice, dal & boiled eggs', [['rice', 1], ['dal', 1], ['egg', 2]], { window: '2to3h' }),
  m('p-poha', 'preGym', 'Poha & curd', [['poha', 1], ['curd', 1]], { window: '2to3h' }),
];

export const mealById = (id: string) => MEALS.find((x) => x.id === id);
