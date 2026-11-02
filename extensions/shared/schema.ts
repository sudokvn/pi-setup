import { Type, type TSchemaOptions } from "typebox";

/**
 * A `{ type: "string", enum }` tool parameter. Some providers reject an enum
 * without a type. pi-ai's `StringEnum` emits the same JSON, but since 1.5.0 its
 * published type is a pi-schema `Schema`, which TypeBox cannot infer inside
 * `Type.Object`.
 */
export const stringEnum = <const Values extends readonly string[]>(
  values: Values,
  options?: TSchemaOptions,
) => Type.Enum<[...Values]>(values, { ...options, type: "string" });
