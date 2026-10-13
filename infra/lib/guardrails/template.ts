// The parts of a synthesized CloudFormation template that the guardrail checks read.

/** A template value; almost any of them can also be an intrinsic function, so the checks read them loosely. */
export type Json = any;

export interface CfnResource {
  Type: string;
  Properties?: Record<string, any>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
}

export interface CfnTemplate {
  Transform?: unknown;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
}
