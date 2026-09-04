import {
  buildSchema,
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputField,
  type GraphQLNamedType,
  type GraphQLType,
  type GraphQLSchema,
} from "graphql";
import type {
  ArgumentFact,
  CodeFact,
  EnumValueFact,
  FieldFact,
  GraphQLTypeKind,
  TypeFact,
} from "../../types/index.js";

/**
 * Deterministic extraction of code facts from a GraphQL SDL string.
 * No LLM is involved here and none should ever be added.
 *
 * Fact IDs:
 *   Type            -> "Order"
 *   Field           -> "Order.status"
 *   Argument        -> "Query.orders(first)"
 *   Enum value      -> "OrderStatus.PENDING"
 */
export function extractGraphqlFacts(sdl: string, file: string): CodeFact[] {
  const schema = buildSchema(sdl, { assumeValidSDL: false });
  return extractFromSchema(schema, file);
}

export function extractFromSchema(schema: GraphQLSchema, file: string): CodeFact[] {
  const facts: CodeFact[] = [];

  for (const type of Object.values(schema.getTypeMap())) {
    if (isIntrospectionType(type) || isSpecifiedScalarType(type)) continue;

    facts.push(typeFact(type, file));

    if (isObjectType(type) || isInterfaceType(type)) {
      for (const field of Object.values(type.getFields())) {
        facts.push(fieldFact(type.name, field, file));
        for (const arg of field.args) {
          facts.push(argumentFact(type.name, field.name, arg, file));
        }
      }
    } else if (isInputObjectType(type)) {
      for (const field of Object.values(type.getFields())) {
        facts.push(inputFieldFact(type.name, field, file));
      }
    } else if (isEnumType(type)) {
      for (const value of type.getValues()) {
        const fact: EnumValueFact = {
          id: `${type.name}.${value.name}`,
          kind: "enum_value",
          enumType: type.name,
          name: value.name,
          deprecated: value.deprecationReason != null,
          origin: origin(file, value.astNode?.loc?.startToken.line),
        };
        if (value.deprecationReason != null) fact.deprecationReason = value.deprecationReason;
        if (value.description) fact.description = value.description;
        facts.push(fact);
      }
    }
  }

  facts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return facts;
}

function isIntrospectionType(type: GraphQLNamedType): boolean {
  return type.name.startsWith("__");
}

function typeKindOf(type: GraphQLNamedType): GraphQLTypeKind {
  if (isObjectType(type)) return "OBJECT";
  if (isInterfaceType(type)) return "INTERFACE";
  if (isUnionType(type)) return "UNION";
  if (isEnumType(type)) return "ENUM";
  if (isInputObjectType(type)) return "INPUT_OBJECT";
  if (isScalarType(type)) return "SCALAR";
  throw new Error(`Unknown GraphQL type kind for ${(type as GraphQLNamedType).name}`);
}

function typeFact(type: GraphQLNamedType, file: string): TypeFact {
  const fact: TypeFact = {
    id: type.name,
    kind: "type",
    name: type.name,
    typeKind: typeKindOf(type),
    origin: origin(file, type.astNode?.loc?.startToken.line),
  };
  if (isObjectType(type) || isInterfaceType(type)) {
    const ifaces = type.getInterfaces().map((i) => i.name);
    if (ifaces.length > 0) fact.members = ifaces.sort();
  } else if (isUnionType(type)) {
    fact.members = type.getTypes().map((t) => t.name).sort();
  }
  if (type.description) fact.description = type.description;
  return fact;
}

function fieldFact(parentType: string, field: GraphQLField<unknown, unknown>, file: string): FieldFact {
  const shape = describeType(field.type);
  const fact: FieldFact = {
    id: `${parentType}.${field.name}`,
    kind: "field",
    parentType,
    name: field.name,
    type: shape.rendered,
    namedType: shape.namedType,
    nullable: shape.nullable,
    isList: shape.isList,
    argumentNames: field.args.map((a) => a.name),
    deprecated: field.deprecationReason != null,
    origin: origin(file, field.astNode?.loc?.startToken.line),
  };
  if (field.deprecationReason != null) fact.deprecationReason = field.deprecationReason;
  if (field.description) fact.description = field.description;
  return fact;
}

function inputFieldFact(parentType: string, field: GraphQLInputField, file: string): FieldFact {
  const shape = describeType(field.type);
  const fact: FieldFact = {
    id: `${parentType}.${field.name}`,
    kind: "field",
    parentType,
    name: field.name,
    type: shape.rendered,
    namedType: shape.namedType,
    nullable: shape.nullable,
    isList: shape.isList,
    argumentNames: [],
    deprecated: field.deprecationReason != null,
    origin: origin(file, field.astNode?.loc?.startToken.line),
  };
  if (field.deprecationReason != null) fact.deprecationReason = field.deprecationReason;
  if (field.description) fact.description = field.description;
  return fact;
}

function argumentFact(parentType: string, fieldName: string, arg: GraphQLArgument, file: string): ArgumentFact {
  const shape = describeType(arg.type);
  const hasDefault = arg.defaultValue !== undefined;
  const fact: ArgumentFact = {
    id: `${parentType}.${fieldName}(${arg.name})`,
    kind: "argument",
    parentType,
    fieldName,
    name: arg.name,
    type: shape.rendered,
    namedType: shape.namedType,
    nullable: shape.nullable,
    hasDefault,
    origin: origin(file, arg.astNode?.loc?.startToken.line),
  };
  if (hasDefault) fact.defaultValue = JSON.stringify(arg.defaultValue);
  if (arg.description) fact.description = arg.description;
  return fact;
}

function describeType(type: GraphQLType): {
  rendered: string;
  namedType: string;
  nullable: boolean;
  isList: boolean;
} {
  const nullable = !isNonNullType(type);
  const inner = isNonNullType(type) ? type.ofType : type;
  return {
    rendered: String(type),
    namedType: getNamedType(type).name,
    nullable,
    isList: isListType(inner),
  };
}

function origin(file: string, line: number | undefined): { file: string; line?: number } {
  return line === undefined ? { file } : { file, line };
}
