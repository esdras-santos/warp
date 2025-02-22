import assert from 'assert';
import {
  AddressType,
  BytesType,
  ContractDefinition,
  ElementaryTypeNameExpression,
  Expression,
  FixedBytesType,
  FunctionCall,
  FunctionCallKind,
  generalizeType,
  IntLiteralType,
  IntType,
  Literal,
  LiteralKind,
  StringLiteralType,
  StringType,
  TypeNameType,
  UserDefinedType,
} from 'solc-typed-ast';
import { AST } from '../../ast/ast';
import { printNode, printTypeNode } from '../../utils/astPrinter';
import { ASTMapper } from '../../ast/mapper';
import { TranspileFailedError } from '../../utils/errors';
import { createAddressTypeName, createUint256TypeName } from '../../utils/nodeTemplates';
import { bigintToTwosComplement, toHexString } from '../../utils/utils';
import { functionaliseIntConversion } from '../../warplib/implementations/conversions/int';
import { createCallToFunction } from '../../utils/functionGeneration';
import { functionaliseFixedBytesConversion } from '../../warplib/implementations/conversions/fixedBytes';
import { functionaliseBytesToFixedBytes } from '../../warplib/implementations/conversions/dynBytesToFixed';
import { safeGetNodeType } from '../../utils/nodeTypeProcessing';
import { FELT_TO_UINT256, UNSAFE_CONTRACT_ADDRESS_FROM_U256 } from '../../utils/importPaths';

export class ExplicitConversionToFunc extends ASTMapper {
  visitFunctionCall(node: FunctionCall, ast: AST): void {
    this.commonVisit(node, ast);
    if (node.kind !== FunctionCallKind.TypeConversion) return;

    const typeNameType = safeGetNodeType(node.vExpression, ast.inference);

    assert(node.vArguments.length === 1, `Expecting typeconversion to have one child`);

    // Since we are only considering type conversions typeTo will always be a TypeNameType
    assert(
      typeNameType instanceof TypeNameType,
      `Got non-typename type ${typeNameType.pp()} when parsing conversion function ${
        node.vFunctionName
      }`,
    );

    if (
      typeNameType.type instanceof UserDefinedType &&
      typeNameType.type.definition instanceof ContractDefinition
    ) {
      const operand = node.vArguments[0];
      operand.typeString = node.typeString;
      ast.replaceNode(node, operand);
      return;
    }

    assert(
      node.vExpression instanceof ElementaryTypeNameExpression,
      `Unexpected node type ${node.vExpression.type}`,
    );
    const typeTo = generalizeType(typeNameType.type)[0];
    const argType = generalizeType(safeGetNodeType(node.vArguments[0], ast.inference))[0];

    const noMatchMsg = `Unexpected type ${printTypeNode(
      argType,
    )} received in conversion to ${printTypeNode(typeTo)}`;
    const onFail = new TranspileFailedError(noMatchMsg);

    if (typeTo instanceof IntType) {
      if (argType instanceof FixedBytesType) {
        assert(
          typeTo.nBits === argType.size * 8,
          `Unexpected size changing ${argType.pp()}->${typeTo.pp()} conversion encountered`,
        );
        const operand = node.vArguments[0];
        operand.typeString = node.typeString;
        ast.replaceNode(node, operand);
      } else if (argType instanceof IntLiteralType) {
        ast.replaceNode(node, literalToTypedInt(node.vArguments[0], typeTo));
      } else if (argType instanceof IntType) {
        functionaliseIntConversion(node, ast);
      } else if (argType instanceof AddressType) {
        const replacementCall = createCallToFunction(
          ast.registerImport(
            node,
            ...FELT_TO_UINT256,
            [['address_arg', createAddressTypeName(false, ast)]],
            [['uint_ret', createUint256TypeName(ast)]],
          ),
          [node.vArguments[0]],
          ast,
        );
        ast.replaceNode(node, replacementCall);
      } else {
        throw onFail;
      }
      return;
    }

    if (typeTo instanceof AddressType) {
      const operand = node.vArguments[0];
      if (argType instanceof AddressType) {
        ast.replaceNode(node, operand);
      } else if (argType instanceof IntLiteralType) {
        operand.typeString = 'address';
        ast.replaceNode(node, operand);
      } else if (
        (argType instanceof IntType && argType.nBits === 256) ||
        (argType instanceof FixedBytesType && argType.size === 32)
      ) {
        const replacementCall = createCallToFunction(
          ast.registerImport(
            node,
            ...UNSAFE_CONTRACT_ADDRESS_FROM_U256,
            [['uint_arg', createUint256TypeName(ast)]],
            [['address_ret', createAddressTypeName(false, ast)]],
          ),
          [operand],
          ast,
        );
        ast.replaceNode(node, replacementCall);
      } else {
        throw onFail;
      }
      return;
    }

    if (typeTo instanceof FixedBytesType) {
      if (argType instanceof AddressType) {
        const replacementCall = createCallToFunction(
          ast.registerImport(
            node,
            ...FELT_TO_UINT256,
            [['address_arg', createAddressTypeName(false, ast)]],
            [['uint_ret', createUint256TypeName(ast)]],
          ),
          [node.vArguments[0]],
          ast,
        );
        ast.replaceNode(node, replacementCall);
      } else if (argType instanceof BytesType) {
        functionaliseBytesToFixedBytes(node, typeTo, ast);
      } else if (argType instanceof FixedBytesType) {
        functionaliseFixedBytesConversion(node, ast);
      } else if (argType instanceof IntLiteralType) {
        ast.replaceNode(node, literalToFixedBytes(node.vArguments[0], typeTo));
      } else if (argType instanceof IntType) {
        assert(
          typeTo.size * 8 >= argType.nBits,
          `Unexpected narrowing ${argType.pp()}->${typeTo.pp()} conversion encountered`,
        );
        const operand = node.vArguments[0];
        operand.typeString = node.typeString;
        ast.replaceNode(node, operand);
      } else if (argType instanceof StringLiteralType) {
        const replacement = literalToFixedBytes(node.vArguments[0], typeTo);
        ast.replaceNode(node, replacement);
      } else {
        throw onFail;
      }
      return;
    }

    if (typeTo instanceof BytesType || typeTo instanceof StringType) {
      if (argType instanceof BytesType || argType instanceof StringType) {
        const operand = node.vArguments[0];
        operand.typeString = node.typeString;
        ast.replaceNode(node, operand);
        return;
      }
    }

    throw onFail;
  }
}

// This both truncates values that are too large to fit in the given type range,
// and also converts negative literals to two's complement
function literalToTypedInt(arg: Expression, typeTo: IntType): Expression {
  assert(
    arg instanceof Literal,
    `Found non-literal ${printNode(arg)} to have literal type ${arg.typeString}`,
  );

  const truncated = bigintToTwosComplement(BigInt(arg.value), typeTo.nBits).toString(10);

  arg.value = truncated;
  arg.hexValue = toHexString(truncated);
  arg.typeString = typeTo.pp();
  return arg;
}

function literalToFixedBytes(arg: Expression, typeTo: FixedBytesType): Expression {
  assert(
    arg instanceof Literal,
    `Found non-literal ${printNode(arg)} to have literal type ${arg.typeString}`,
  );

  if (arg.kind === LiteralKind.HexString || arg.kind === LiteralKind.String) {
    if (arg.hexValue.length < typeTo.size * 2) {
      arg.hexValue = `${arg.hexValue}${'0'.repeat(typeTo.size * 2 - arg.hexValue.length)}`;
    }
  }
  arg.typeString = typeTo.pp();
  if (arg.kind === LiteralKind.String) arg.kind = LiteralKind.HexString;
  return arg;
}
