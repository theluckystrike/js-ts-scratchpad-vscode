'use strict';
// The text a new scratchpad starts with. Short, so a beginner sees values within a second.

const JS = `// JavaScript Playground: values show at the end of each line while you type.
// Change anything. Nothing is sent anywhere; your code runs on this computer.
const greeting = 'Hello';
greeting.toUpperCase();

const nums = [3, 1, 2];
nums.sort((a, b) => a - b);

for (const n of nums) {
  console.log('n is', n);
}

const user = { name: 'Ada', langs: new Set(['js', 'ts']) };
user.langs.has('ts');

await new Promise((resolve) => setTimeout(resolve, 50));
'top-level await works';
`;

const TS = `// TypeScript Scratchpad: values show at the end of each line while you type.
// No tsconfig and no install needed. Nothing is sent anywhere.
interface User {
  name: string;
  age: number;
}

const users: User[] = [
  { name: 'Ada', age: 36 },
  { name: 'Linus', age: 28 },
];

users.map((u) => u.name);

function oldest<T extends { age: number }>(list: T[]): T {
  return list.reduce((a, b) => (b.age > a.age ? b : a));
}

oldest(users).name;

enum Level { Low = 1, High = 3 }
Level.High;

const config = { retries: 3, verbose: true } satisfies Record<string, number | boolean>;
console.log('config', config);
`;

module.exports = { JS, TS };
