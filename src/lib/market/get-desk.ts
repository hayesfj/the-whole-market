import { createServerFn } from "@tanstack/react-start";

export const getDesk = createServerFn({ method: "GET" })
  .validator((input: { fresh?: boolean } | undefined) => ({
    fresh: Boolean(input?.fresh),
  }))
  .handler(async ({ data }) => {
    const { loadDesk } = await import("./compute.server");
    return loadDesk(data.fresh);
  });
