// Empty stub for Node.js modules that shouldn't be used in browser
export default {};
export const PassThrough = class PassThrough {};
export const Readable = class Readable {};
export const Writable = class Writable {};
export const Transform = class Transform {};
export const spawn = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const exec = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const readFile = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const writeFile = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const mkdir = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const stat = () => {
  throw new Error('Node.js functionality not available in browser');
};
export const join = (...args) => args.join('/');
export const resolve = (...args) => args.join('/');
export const dirname = (path) => path.split('/').slice(0, -1).join('/');
export const basename = (path) => path.split('/').pop();
export const extname = (path) => {
  const parts = path.split('.');
  return parts.length > 1 ? '.' + parts.pop() : '';
};
