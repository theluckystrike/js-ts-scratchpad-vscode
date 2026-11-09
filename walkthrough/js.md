# A JavaScript scratchpad

The scratchpad opens with a short example. Each line that has a value shows it at the end of the line:

```js
const nums = [3, 1, 2];        nums = [ 3, 1, 2 ]
nums.sort((a, b) => a - b);    [ 1, 2, 3 ]
console.log('n is', n);        › n is 1 · n is 2 · n is 3
```

Change a number and the values update about 300 ms after you stop typing. Hover a value to see more of it. Click the status bar item to see the full console output.

Nothing is sent anywhere. The code runs on this computer in a separate process that stops after 5 seconds.
