// takes an IR function object and returns a list of Scratch blocks

spWeight = 0;

module.exports.ffi = {};

module.exports.generateFunctionHat = function(functionContext, func) {
    var spec = func.funcName;
    var inputs = [];
    var defaults = [];

    functionContext.params = [];

    for(var i = 0; i < func.paramList.length; ++i) {
        var pName = "param" + i;

        if(func.paramList[i][1]) {
            pName = func.paramList[i][1].slice(1);
            inputs.push(pName);
            functionContext.params.push("%"+pName);
        } else {
            inputs.push(pName);
            functionContext.params.push(pName);
        }

        defaults.push(defaultForType(func.paramList[i][0]));
        spec += " "+specifierForType(func.paramList[i][0]);
    }


    return ["procDef", spec, inputs, defaults, false];

}

module.exports.compileFunction = function(func, IR) {
    var functionContext = {
        locals: {},
        localTypes: {},
        globalLocalDepth: 0,
        scopedLocalDepth: 0,
        params: [],
        gotoInit: false,
        globalToFree: 0,
        scopeToFree: 0,
        scoped: false,
        globals: IR.globals,
        rootGlobal: IR.rootGlobal,
        phiAssignments: {},
        phiNodes: {}
    }

    var blockList = [module.exports.generateFunctionHat(functionContext, func)];

    if(func.inGotoComplex) {
        blockList = blockList.concat(initGotoComplex());
    }

    // before we do anything, we need to look for `phi` AOT
    // we don't do anything at this point, but we need this cached
    // the goto complex below can work its magic to make this work

    for(var i = 0; i < func.code.length; ++i) {
        if(func.code[i].type == "set"
          && func.code[i].val
          && func.code[i].val.type == "phi") {
            func.code[i].val.options.forEach(function(option) {
                var value = option[0],
                    label = option[1].slice(1);

                if(!functionContext.phiAssignments[label])
                    functionContext.phiAssignments[label] = [];

                functionContext.phiAssignments[label].push(
                        [func.code[i].name,
                         value]
                );
            });
        }
    }

    console.log(functionContext.phiAssignments);

    for(var i = 0; i < func.code.length;) {
        var iGain = 1;

        var hasGotoComplex = functionContext.gotoComplex && functionContext.gotoComplex.okToUse && functionContext.gotoComplex.active; // this MUST be before compileInstruction for branching to work
        // optimize out repeated set stack / change sp -1
        if(func.code[i].type == "set" && func.code[i+1].type == "set" && func.code[i].spWeight === undefined) {
            // count how many... it might not just be two
            // we also rewire them in place to offset the sp

            var j = 0;
            var ignored = 0;
            var lastNonIgnored = 0;

            while(func.code[i+j].type == "set"
                  && !(func.code[i+j].val.type == "comparison"
                       && func.code[i+j+1].type == "branch")) {
                

                if(func.code[i+j].val.type == "phi") {
                    ignored++;
                } else {
                    lastNonIgnored = j;
                    func.code[i+j].spWeight = j - ignored;
                    func.code[i+j].skipCleanup = true;

                }

                ++j;
            }

            if(func.code[i+j+1] && func.code[i+j+1].type == "branch") {
                console.log("We have a don't cleanup");
                func.code[i+j+1].dontCleanup = ignored - j;
                console.log(func.code[i+j+1]);
            } else {
                func.code[i+lastNonIgnored].skipCleanup = -j + ignored;
            }
        }
        
        // optimize out alloca calls
        if(func.code[i].type == "set" && 
           func.code[i].computation == [] && func.code[i].value == 0 &&
           func.code[i+1].type == "store" && func.code[i+1].destination.value == func.code[i].name) {

            func.code[i].value = func.code[i+1].src.value;
            iGain++;
        }

        // optimize out icmp in conditional branch
        if(func.code[i].type == "set" && func.code[i].val.type == "comparison" &&
            func.code[i+1].type == "branch" && func.code[i+1].conditional && func.code[i+1].condition == func.code[i].name) {

            func.code[i] = {
                type: "branch",
                conditional: true,
                dest: func.code[i+1].dest,
                falseDest: func.code[i+1].falseDest,
                generateCondition: true,
                rawCondition: true,
                val: func.code[i].val,
                dontCleanup: func.code[i+1].dontCleanup
            };

            iGain++;
        }

        

        var instruction = compileInstruction(functionContext, func.code[i], (i + 1) == func.code.length);

        if(!functionContext.gotoInit && functionContext.gotoComplex && functionContext.gotoComplex.okToUse) {
            blockList = blockList.concat([functionContext.gotoComplex.forever]);
            functionContext.gotoInit = true;
        }
        if(hasGotoComplex) {
            if(functionContext.gotoComplex.currentContext[2]) {
                functionContext.gotoComplex.currentContext[2] =
                    functionContext.gotoComplex.currentContext[2].concat(instruction);
            } else {
                functionContext.gotoComplex.currentContext[2] = instruction;
            }
        } else {
            blockList = blockList.concat(instruction);
        }

        i += iGain;
    }

    //blockList = blockList.concat(returnBlock());

    return blockList;
}

function compileInstruction(ctx, block, final) {
    if(block.type == "call") {
        // calling a (potentially foreign) function
        return callBlock(ctx, block);
    } else if(block.type == "ffi") {
        // FFI block
        // load the code from the options
        return module.exports.ffi[block.ffiBlock];
    } else if(block.type == "set") {
        var val = 0;
        if(!block.val.vtype) console.log(block.val);
        var type = block.val.vtype || "";
        
        spWeight = block.spWeight || 0;

        if(block.val.type == "return value") {
            val = ["readVariable", "return value"];
        } else if(block.val.type == "variable") {
            val = fetchByName(ctx, block.val.name, block.val.vtype);
            type = block.val.vtype;
        } else if(block.val.type == "arithmetic") {
            val = [block.val.operation, fetchByName(ctx, block.val.operand1), fetchByName(ctx, block.val.operand2)];
        } else if(block.val.type == "comparison") {
            val = icmpBlock(ctx, block);
        } else if(block.val.type == "sext") {
            val = signExtend(ctx, block.val);
        } else if(block.val.type == "trunc") {
            val = truncate(ctx, block.val);
        } else if(block.val.type == "phi") {
            // it's not necessary to actually do anything here
            // but we *do* need to signal the caller that nothing should happen
            // else the stack gets all messy 
            
            return [];    
        } else if(block.val.type == "addressOf") { // todo: full getelementptr implementation
            console.log("Offset for "+block.val.base.name+" = " + block.val.offset);
            val = addressOf(ctx, block.val.base.name, block.val.offset);
        } else if(block.val.type == "srem") {
            val = ["computeFunction:of:", "floor", ["%", fetchByName(ctx, block.val.operand1), fetchByName(ctx, block.val.operand2)]]
        } else if(block.val.type == "ashr") {
            val = [
                            "computeFunction:of:",
                            "floor",
                            ["/",
                                fetchByName(ctx, block.val.operand1),
                                exponentTwo(fetchByName(ctx, block.val.operand2))
                            ]
                        ];
        } else if(block.val.type == "and") {
            val = bitwise_and(fetchByName(ctx, block.val.operand1), fetchByName(ctx, block.val.operand2));
            console.log(val);
        } else {
            console.log("Unknown equality in backend");
            console.log(block.val);
        }

        var computedInstructions = compileInstruction(ctx, block.computation);

        /*if(computedInstructions === null) // short-circuit, used for implementing phi
            return [];*/

        return computedInstructions
                .concat(allocateLocal(ctx, val, block.name, type, block.skipCleanup));
    } else if(block.type == "ret") {
        return returnBlock(ctx, block.value, final);
    } else if(block.type == "store") {
        return dereferenceAndSet(ctx, block.destination.value, block.src.value);
    } else if(block.type == "gotoComplex") {
        ctx.gotoComplex = {
            context: [],
            okToUse: false,
            forever: ["doForever", []],
            active: true
        }

        //return [ctx.gotoComplex.forever];
    } else if(block.type == "label") {
        if(ctx.scoped) {
            ctx.gotoComplex.currentContext[2] =
                ctx.gotoComplex.currentContext[2].concat(freeLocals(ctx));
        }

        ctx.scoped = true;

        var chunk = ["doIfElse", ["=", getCurrentLabel(), block.label], [], []];

        ctx.gotoComplex.okToUse = true;
        ctx.gotoComplex.active = true;

        if(ctx.gotoComplex.currentContext) {
            ctx.gotoComplex.currentContext[3] = [chunk];
            ctx.gotoComplex.currentContext = ctx.gotoComplex.currentContext[3][0];
        } else {
            ctx.gotoComplex.currentContext = chunk;
            ctx.gotoComplex.context = ctx.gotoComplex.currentContext;
            ctx.gotoComplex.forever[1] = [ctx.gotoComplex.context];
        }

        ctx.currentLabel = block.label;

    } else if(block.type == "branch") {
        ctx.gotoComplex.active = false;

        var output = [];

        // if there is a relevant phi instruction, we need to tap into that
        if(ctx.phiAssignments[ctx.currentLabel || 0]) {
            output = output.concat(assignPhi(ctx, ctx.phiAssignments[ctx.currentLabel || 0], Object.keys(ctx.phiNodes).length));
        }

        // remember the don't cleanup
        // for the label ahead of us
        ctx.dontCleanup = block.dontCleanup;

        console.log(block);
        spWeight -= ctx.dontCleanup || 0;
        if(spWeight) {
            console.log("We've got a cleanup");
        }

        if(block.conditional) {
            if(block.generateCondition) {
                block.condition = icmpBlock(ctx, block)[1];
            }

            var cond = block.rawCondition ? block.condition : ["=", fetchByName(ctx, block.condition), 1];
        
            // the ternary statement a ? b : c
            // is equivalent to the expression,
            // b + a*(c-b)
            // this is an optimization by itself,
            // but we *also* know the value of c-b at compile-time
            // which reduces the complexity of this immensely
            
            var d1 = block.falseDest.slice(1) * 1;
            var d2 = block.dest.slice(1) * 1;

            var distance = d1 - d2;
            
            // to shave off a byte (it counts!), ensure the signs are well formed
            var operation = "-";

            if(distance < 0) {
                operation = "+";
                distance *= -1;
            }

            // multiply cond by distance to get the change amount
            
            if(distance != 1)
                cond = ["*", distance, cond];

            output = output.concat(
                    absoluteBranch([operation, d1, cond]));
        } else {
            output = output.concat(
                    absoluteBranch(block.dest.slice(1)));
        }

        spWeight += ctx.dontCleanup || 0;
        return output;
    }

    return [];
}

function assignPhi(ctx, nodes, offset) {
    offset = offset || 0;

    var output = [];

    nodes.forEach(function(node, num) {
        // if this variable is already accounted for,
        // don't generate a new offset for it
        
        var off = ctx.phiNodes[node[0]] || (offset + num + 1);
        
        // add it to a generic phi list
        output.push(
                ["setLine:ofList:to:", off, "phi", fetchByName(ctx, node[1], node[2])]
        );

        // create a mapping for easy access later
        
        ctx.phiNodes[node[0]] = off; 
    });

    return output;
}

// fixme: stub
function defaultForType(type) {
    return 0;
}

// fixme: stub
function specifierForType(type) {
    return "%s";
}

// fixme: stub
function formatValue(ctx, type, value) {
    if(typeof value == "object") {
        if(value.type == "getelementptr") {
            // fixme: necessary and proper implementation
            return addressOf(ctx, value.base.val, value.offset);
        }
    }

    if(value[0] == '%') {
        return fetchByName(ctx, value);
    }

    return value;
}

function getOffset(ctx, value) {
    return ctx.globalLocalDepth + ctx.scopedLocalDepth - ctx.locals[value];
}

function stackPtr() {
    if(spWeight !== 0)
        return ["-", ["readVariable", "sp"], spWeight];

    return ["readVariable", "sp"];
}

function stackPosFromOffset(offset) {
    // optimize zero-index
    if(offset == 0)
        return stackPtr();

    return ["+", stackPtr(), offset];
}

// higher-level code generation

function allocateLocal(ctx, val, name, type, skipCleanup) {
    if(name) {
        var depth = 0;

        if(ctx.scoped) {
            depth = ctx.globalLocalDepth + (ctx.scopedLocalDepth++);
        } else {
            depth = ctx.globalLocalDepth++;
        }

        ctx.locals[name] = depth;
        ctx.localTypes[name] = type;
    }

    if(ctx.scoped) {
        ctx.scopeToFree++;
    } else {
        ctx.globalToFree++;
    }

    var out = [
        ["setLine:ofList:to:", stackPtr(), "DATA", val],
        ["changeVar:by:", "sp", -1]
    ];

    if(skipCleanup !== undefined) {
        if(skipCleanup === true)
            out = [out[0]];
        else {
            out[1][2] = skipCleanup;
            spWeight = 0; // reset everything again
        }
    }

    return out;
}

function freeStack(num) {
    if(num > 0) {
        return [
            ["changeVar:by:", "sp", num]
            //["doRepeat", num, [["deleteLine:ofList:", "last", "Stack"]]],
        ];
    } else { // optimization on freeing nothing
        return [];
    }
}

function freeLocals(ctx, keepGlobals) {
    var numToFree = !!keepGlobals * ctx.globalToFree;

    if(ctx.scoped) {
        numToFree += ctx.scopeToFree - ctx.dontCleanup;
        ctx.scopeToFree = 0;
        ctx.scopedLocalDepth = 0;
    }

    return freeStack(numToFree);
}

function fetchByName(ctx, n, expectedType) {
    var offsetFound = null;
    var actualType = null;

    n = n.toString(); 

    if(ctx.locals[n] !== undefined) {
        console.log("For local "+n);
        console.log("Offset "+getOffset(ctx,n));
        console.log("Stack pos"+stackPosFromOffset(getOffset(ctx,n)));
        offsetFound = stackPosFromOffset(getOffset(ctx, n));
        actualType = ctx.localTypes[n];
    } else if(ctx.rootGlobal[n.slice(1)] !== undefined){
        offsetFound = ctx.rootGlobal[n.slice(1)].ptr;
        actualType = ctx.rootGlobal[n.slice(1)].type + "*"; // accounts for LLVM's underlying implementation of globals
    }
    
    if(offsetFound !== null) {
        var stackPos = offsetFound; 
        var o = ["getLine:ofList:", stackPos, "DATA"];

        if(expectedType) {
            var actualReferenceCount = actualType.split('*').length - 1;
            var expectedReferenceCount = expectedType.split('*').length - 1;

            if(expectedReferenceCount == actualReferenceCount - 1) {
                // dereference
                return ["getLine:ofList:", o, "DATA"];
            } else if(expectedReferenceCount == actualReferenceCount + 1) {
                // addressOf
                return stackPos;
            }

            if(expectedReferenceCount != actualReferenceCount)
                console.log("WARNING: Expecting "+expectedReferenceCount+", actually" + actualReferenceCount);
        }


        return o;
    } else if(ctx.params.indexOf(n) > -1) {
        return ["getParam", n.slice(1), "r"];
    } else if(ctx.phiNodes[n] !== undefined) {
        return ["getLine:ofList:", ctx.phiNodes[n], "phi"];
    } else if( (n * 1) == n) {
        return n
    } else {
        console.log("fetchByName undefined "+n);
        //console.log(ctx.locals);
        return ["undefined"];
    }
}

function addressOf(ctx, n, offset) {
    // TODO: full implementation
    // this will work for now, anyway

    // first, we need to get the address of the base pointer
    // this will either be a standard stack-based pointer, or a reference to rootGlobal

    var base = 0;

    if(ctx.rootGlobal[n.slice(1)])
        base = ctx.rootGlobal[n.slice(1)].ptr;
    else if(ctx.locals[n])
        base = ["getLine:ofList:", stackPosFromOffset(getOffset(ctx, n)), "DATA"];

    // then, we add the offset
    // if necessary
    
    offset *= 1;
   
    if(offset === 0)
        return base; // adding by zero is silly

    return ["+", base, offset];
}

function returnBlock(ctx, val, final) {
    var proc = [];

    if(val) {
        var ret = formatValue(ctx, val[0], val[1]);
        
        if(ret)
            proc.push(["setVar:to:", "return value", ret]);
    }
    
    proc = proc.concat(freeLocals(ctx, true));

    if(ctx.gotoComplex) {
        proc = proc.concat(cleanGotoComplex());
    }

    if(!final)
        proc.push(["stopScripts", "this script"]);

    return proc;
}

function callBlock(ctx, block) {
    var spec = block.funcName;
    var args = [];
    
    var varargs = false;

    if(block.returnType.indexOf("...") > -1) {
        varargs = true;
    }
    
    console.log(block);
    
    for(var a = 0; a < block.paramList.length; ++a) {
        args.push(formatValue(ctx, block.paramList[a][0], block.paramList[a][1]));
        spec += " "+specifierForType(block.paramList[a][0]);
    }

    if(varargs) {
        // TODO: varargs

        args.push(-1);
        spec += " %s";
    }

    return [
        ["call", spec].concat(args)
    ];
}

// TODO: more robust implementation to support heap

function dereferenceAndSet(ctx, ptr, content) {
    if(ptr[0] == "@") {
        return [
            [
                "setLine:ofList:to:",
                ctx.rootGlobal[ptr.slice(1)].ptr,
                "DATA",
                fetchByName(ctx, content)
            ]
        ];
    } else if(ptr[0] == "%") {
        return [
            [
                "setLine:ofList:to:",
                stackPosFromOffset(getOffset(ctx, ptr)),
                "DATA",
                fetchByName(ctx, content)
            ]
        ];
    } else {
        console.log("Unkown dereferenced variable start: "+n);
    }

}

function specForComparison(comp) {
    if(comp == "eq") {
        return "=";
    } else if(comp == "ne") {
        return "!=";
    } else if(comp == "slt" || comp == "ult") {
        return "<";
    } else if(comp == "sgt" || comp == "ugt") {
        return ">";
    }
    return "undefined";
}

function initGotoComplex() {
    return [
        ["append:toList:", 0, "Label Stack"]
    ];
}

function getCurrentLabel() {
    return ["getLine:ofList:", "last", "Label Stack"];
}

function cleanGotoComplex() {
    return [
        ["deleteLine:ofList:", "last", "Label Stack"]
    ];
}

function absoluteBranch(dest) {
    return [
        ["setLine:ofList:to:", "last", "Label Stack", dest]
    ];
}

function castToNumber(b) {
    return ["*", b, 1];
}

function icmpBlock(ctx, block) {
    var spec = specForComparison(block.val.operation);
    var negate = false;

    if(spec[0] == "!") {
        negate = true;
        spec = spec.slice(1);
    }

    var b = [spec, fetchByName(ctx, block.val.left), fetchByName(ctx, block.val.right)];

    if(negate) {
        b = ["not", b];
    }

    return castToNumber(b);
}

function signExtend(ctx, block) {
    // TODO: once we support typing correctly, sign extend will need a proper implementation too
    return fetchByName(ctx, block.source);
}

function truncate(ctx, block) {
    // TODO: once we support typing correctly, truncate will need a proper implementation too
    return fetchByName(ctx, block.source);
}

function exponentTwo(v) {
    return ["computeFunction:of:", "floor", ["computeFunction:of:", "e ^",
                        ["*", v, 0.69314718056]
                    ]];
}

// TODO: very hacky. find better solution soon.
function components8(op) {
    return [
                        ["%", op, 16],
                        ["/", ["-", op, ["%", op, 16]], 16]
                    ];
}

function bitwise_and4(op1, op2) {
    return ["getLine:ofList:", ["+", ["+", ["*", op1, 16], op2], 1], "4-bit AND"]
}

function bitwise_and(op1, op2) {
    // assume i8 for now TODO: multi width

    op1 = components8(op1);
    op2 = components8(op2);

    return ["+",
            ["*", bitwise_and4(op1[1], op2[1]), 16],
            bitwise_and4(op1[0], op2[0])
    ];
}
