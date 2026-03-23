import { ZodSchema } from "zod";
export function validate<T>(schema: ZodSchema<T>, input: unknown): T { return schema.parse(input); }
