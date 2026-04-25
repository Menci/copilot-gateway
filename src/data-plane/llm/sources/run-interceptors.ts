export type SourceInterceptor<TResult> = (
  result: TResult,
) => TResult | Promise<TResult>;

export const runSourceInterceptors = async <TResult>(
  result: TResult,
  interceptors: readonly SourceInterceptor<TResult>[],
): Promise<TResult> => {
  let intercepted = result;

  for (const interceptor of interceptors) {
    intercepted = await interceptor(intercepted);
  }

  return intercepted;
};
