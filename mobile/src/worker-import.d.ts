declare module "*?worker" {
  const constructor: { new(options?: WorkerOptions): Worker };
  export default constructor;
}
