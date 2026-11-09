# TypeScript with no setup

Interfaces, types, generics, enums and `satisfies` work without a tsconfig or a TypeScript install. The types are removed on the fly and every value stays on the line you wrote it on.

```ts
interface User { name: string; age: number }
const users: User[] = [{ name: 'Ada', age: 36 }];
users.map((u) => u.name);      [ 'Ada' ]
```

Type errors are not checked here (VS Code already underlines them). The code runs as JavaScript.
