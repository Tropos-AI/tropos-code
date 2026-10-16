// web/src/components/admin/use-admin-resource.ts — loads one admin method for a page, with the same loading, error and
// refresh behaviour as the RPC pages (useRpcResource), keyed by the method and its parameters.
import { useRpcResource, type Resource } from "@/components/pages/use-rpc-resource";
import type { AdminArgs } from "@/lib/client";
import { useAdmin } from "@/lib/store";

import type { AdminMethod, AdminResult } from "@core/web/admin/api";

export function useAdminResource<M extends AdminMethod>(method: M, ...args: AdminArgs<M>): Resource<AdminResult<M>> {
  const admin = useAdmin();
  const key = `admin:${method}:${args[0] === undefined ? "" : JSON.stringify(args[0])}`;
  return useRpcResource<AdminResult<M>>(key, () => admin(method, ...args));
}
