> **LLM ingestion note**  
> - All math is LaTeX inside `$$ ... $$` (judgements and erasure rules included).
> - `\vdash_{U}` / `\vdash_{M}` distinguish unmarked vs. marked typing.
> - `\mapsto` is the *marking* relation; `\check{e}` denotes a marked expression.
> - `\square` is an empty expression hole; `?` is the unknown/gradual type.
> - Error marks: `\triangleright_{\not\to}`, `\triangleright_{\not\times}`, `\triangleright_{\not\sqcap}`.
>

<!-- Page 1 -->
## Total Type Error Localization and Recovery with Holes

ERIC ZHAO, University of Michigan, USA
RAEF MAROOF, University of Michigan, USA
ANAND DUKKIPATI, University of Michigan, USA
ANDREW BLINN, University of Michigan, USA
ZHIYI PAN, University of Michigan, USA
CYRUS OMAR, University of Michigan, USA

Type systems typically only define the conditions under which an expression is well-typed, leaving ill-typed
expressions formally meaningless. This approach is insufficient as the basis for language servers driving
modern programming environments, which are expected to recover from simultaneously localized errors and
continue to provide a variety of downstream semantic services. This paper addresses this problem, contributing
the first comprehensive formal account of total type error localization and recovery: the marked lambda
calculus. In particular, we define a gradual type system for expressions with marked errors, which operate as
non-empty holes, together with a total procedure for marking arbitrary unmarked expressions. We mechanize
the metatheory of the marked lambda calculus in Agda and implement it, scaled up, as the new basis for Hazel,
a full-scale live functional programming environment with, uniquely, no meaningless editor states.
The marked lambda calculus is bidirectionally typed, so localization decisions are systematically predictable
based on a local flow of typing information. Constraint-based type inference can bring more distant information
to bear in discovering inconsistencies but this notoriously complicates error localization. We approach this
problem by deploying constraint solving as a type-hole-filling layer atop this gradual bidirectionally typed
core. Errors arising from inconsistent unification constraints are localized exclusively to type and expression
holes, i.e., the system identifies unfillable holes using a system of traced provenances, rather than localized in
an ad hoc manner to particular expressions. The user can then interactively shift these errors to particular
downstream expressions by selecting from suggested partially consistent type hole fillings, which returns
control back to the bidirectional system. We implement this type hole inference system in Hazel.

$$CCS Concepts: • Software and its engineering \to General programming languages; • Theory of$$
$$computation \to Type theory.$$

Additional Key Words and Phrases: type errors, bidirectional typing, gradual typing, type inference

ACM Reference Format:
Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar. 2024. Total Type Error
$$Localization and Recovery with Holes. Proc. ACM Program. Lang. 8, POPL, Article 68 (January 2024), 28 pages.$$
$$https://doi.org/10.1145/3632910$$

Authors’ addresses: Eric Zhao, University of Michigan, Ann Arbor, USA, zzhaoe@umich.edu; Raef Maroof, University of
Michigan, Ann Arbor, USA, maroofr@umich.edu; Anand Dukkipati, University of Michigan, Ann Arbor, USA, anandrav@
umich.edu; Andrew Blinn, University of Michigan, Ann Arbor, USA, blinnand@umich.edu; Zhiyi Pan, University of Michigan,
Ann Arbor, USA, zhiyipan@umich.edu; Cyrus Omar, University of Michigan, Ann Arbor, USA.

Permission to make digital or hard copies of part or all of this work for personal or classroom use is granted without fee
provided that copies are not made or distributed for profit or commercial advantage and that copies bear this notice and
the full citation on the first page. Copyrights for third-party components of this work must be honored. For all other uses,
$$contact the owner/author(s).$$
© 2024 Copyright held by the owner/author(s).
$$ACM 2475-1421/2024/1-ART68$$
$$https://doi.org/10.1145/3632910$$

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 2 -->
$$68:2$$
Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar

1
INTRODUCTION

Modern programming environments provide developers with a collection of semantic services—for
example, type hints, semantic navigation, semantic code completion, and automated refactorings—
that require static reasoning about the type and binding structure of a program as it is being edited.
The problem is that when the program being edited is ill-typed, these semantic services can become
degraded or unavailable [Omar et al. 2017b]. These gaps in service are not always transient. For
example, a change to a type definition might result in type errors at dozens of use sites in a large
program, which might take hours or days to resolve, all without the full aid of these services.
These service gaps are fundamentally rooted in a definitional gap: a type system defined in the
conventional way, e.g., in the tradition of the typed lambda calculus and its derivatives [Pierce
2002], assigns meaning only to well-typed programs. If a type error appears anywhere, the program
is formally meaningless everywhere.
This gap problem has prompted considerable practical interest in (1) type error localization:
mechanisms for identifying the location(s) in a program that explain a type error, and (2) type
error recovery: mechanisms that allow the system to optimistically recover from a localized
type error and continue on to locate other errors and provide downstream semantic services,
ideally at every location in the program and with minimal degradation in service. Essentially all
widely-used programming systems have some support for type error localization, e.g., in compiler
error messages or directly in the editor via markings decorating localized errors. Developers are
known to attend to reported error locations when debugging type errors [Joosten et al. 1993].
Many systems also attempt recovery in certain situations, discussed below. However, type error
localization and recovery mechanisms have developed idiosyncratically, in part as folklore amongst
language and tool implementors. Different type checkers or language servers [Barros et al. 2022;
Bour et al. 2018], even for the same language, localize and recover from type errors in different
ways, with little in the way of unifying theory of the sort that grounds the design of modern type
systems themselves.
Consider, for example, the ill-typed program below, which is shown as presented to the user in
this paper’s version of Hazel [Hazel Development Team 2023], a typed functional dialect of Elm
$$[Czaplicki and Chong 2013]. Hazel supports local type inference, specified in the well-established$$
bidirectional style [Dunfield and Krishnaswami 2019; Omar et al. 2017a; Pierce and Turner 2000]:

> [Non-text content omitted at bbox (165.0, 462.5, 321.0, 523.0)]
A type checker with no support for error localization or recovery—as students in an undergraduate
course might write—would simply report that this program is ill-typed. A more practical approach,
and one common even in production type checkers, is to localize the first error that causes type-
checking to fail and emit an explanatory error message before terminating. In this example, the
system might report that the variable f located on Line 2 is free, then terminate.
An implementation with support for type error recovery, like Elm’s compiler or OCaml’s merlin

[Bour et al. 2018], would be tasked with continuing past this first error. The general difficulty here
is that there is now missing semantic information, namely the type of f, that the bidirectional type
system as specified would appear to demand in order to proceed, here in order to determine which
type the argument, y, is to be analyzed against. Intuitively, however, it is clear that this knowledge

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 3 -->
Total Type Error Localization and Recovery with Holes
$$68:3$$

is unnecessary to make an error localization decision about y: it is free, so a second error can be
simultaneously localized despite the missing information about f.
To recover further, we might choose to also ignore the bidirectional type system’s demand that
the conditional guard be confirmed to be a boolean expression (because the type of f(y) is also
not well-defined) and continue into its branches, observing that they have inconsistent types, Bool
$$and Int. There are several ways to localize this error. One approach, taken e.g., by Elm and merlin,$$
would be to assume, arbitrarily, that one branch is correct, localizing the error to the other branch.
Heuristics have been developed to help make this choice less arbitrary, e.g., by observing recent
editing history [Chuchem and Lotem 2019], or training a machine learning model [Seidel et al. 2017].
A less ad hoc approach, which Hazel takes above, is to localize the inconsistency to the conditional
as a whole, reporting that the problem is that the branch types differ. When the cursor is on this
conditional expression, the Hazel type inspector—a status bar that reports typing information,
including error messages, about the term at the cursor [Potter and Omar 2020]—displays:

> [Non-text content omitted at bbox (65.5, 249.7, 420.4, 262.8)]
This localization decision affects how the system recovers as it proceeds into the let body. If
localization had assumed that the then branch were correct, as for example in merlin, then x : Bool
and an error should be reported on only the second use of x. If the else branch were chosen, then
x : Int and an error would be reported on only the first use of x. In either case, this error might
mislead the programmer if the earlier localization guess was incorrect. If the inconsistency were
localized to the conditional expression as a whole, as in Hazel, then we again confront the problem
of missing type information: x does not have a known type, though it is known to be bound. There
is no definitive type or binding error at either use of x, so we do not report an error in Hazel.
More specifically, we treat x’s type as the unknown a.k.a. dynamic type from gradual typing [Siek
and Taha 2006]. In any of these cases, we would like to be able to recover and localize the type
inconsistency on the string addend because the + operator is integer addition in Hazel. Recovering
from this error, we can assume that both branch types in the second conditional will have Int type,
so no error is marked on the conditional as a whole.
This informal exercise demonstrates that (1) localization choices can vary, particularly with
regard to the extent to which they make ad hoc guesses about intent; (2) when combined with error
recovery, one localization decision can influence downstream localization decisions; and (3) error
recovery necessitates reasoning without complete knowledge about types and binding. We argue
that such semantic subtleties call for a rigorous theoretical treatment of these topics.
Section 2 of this paper develops the first comprehensive type-theoretic formulation of type error
localization and recovery, called the marked lambda calculus. We bring together three individually
well-studied ideas: (1) bidirectional typing, which specifies how type and binding information
flows from type annotations to expressions [Dunfield and Krishnaswami 2019; Pierce and Turner
2000], (2) gradual typing, which offers a principled approach for recovering from missing type
information [Siek and Taha 2006; Siek et al. 2015], and (3) non-empty holes, which function as
syntactic membranes marking erroneous terms [Omar et al. 2017a], operationalizing the “red
lines” that an editor displays. The marked lambda calculus achieves total error recovery, meaning
that every syntactically well-formed program sketch (a program structure with, optionally, empty
$$holes [Solar-Lezama 2013]) can be marked, i.e., its errors can be simultaneously localized, such$$
that the resulting program has a well-defined type and binding structure. We establish this and
other properties as metatheorems that we mechanize in the Agda proof assistant. As we define
the calculus, we consider a number of situations where error localization decisions are subtle
and conclude by defining some extensions of the intentionally minimal core calculus, e.g., with

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 4 -->
$$68:4$$
Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar

destructuring patterns and System F-style polymorphism, that serve as case studies of the general
approach that we hope will be adopted by language designers defining practical type systems.
Section 3.1 describes our own effort in this direction, which is to scale up the marked lambda
calculus as the new basis for Hazel, a typed functional programming environment that fully solves
the semantic gap problem: Hazel’s semantic services are available as long as the program sketch
is syntactically well-formed. Prior work has separately considered mechanisms for maintaining
syntactically well-formed program sketches during development: manual hole insertion (as in
$$Agda [Norell 2007], GHC Haskell [HaskellWiki 2014], Idris [Brady 2013], and others), syntax error$$
recovery [de Medeiros et al. 2020; Sorkin and Donovan 2011], and structure editing [Omar et al.
2017a; Teitelbaum and Reps 1981]. Hazel has both a textual syntax and a structure editor [Moon
$$et al. 2023; Omar et al. 2017a]. As a secondary contribution, Section 3.2 describes how (1) total$$
marking can resolve the problem of undefined behavior in the Hazelnut structure editor calculus,
and (2) integrating marking with typed structure editing allows us to incrementally re-mark only
where necessary based on the edit location and the type and binding structure.
The developments in Section 2 support the intuition (remarked upon by Pierce and Turner

[2000] and Dunfield and Krishnaswami [2019]) that bidirectional typing pairs well with type
error localization and recovery because information flows systematically and locally through the
tree. However, many functional languages including Elm, OCaml and Haskell feature constraint-
based type inference, where constraints are gathered globally. For type systems where inference
is decidable, this is powerful, but it is also notorious for complicating error localization, because
inconsistencies can arise through a confluence of constraints originating from any number of
$$locations [Wand 1986].$$
For example, in the following Hazel expression (ignoring the error on the type hole for the
moment), bidirectional error localization does not mark any uses of x as erroneous because a type
for x cannot locally be inferred (the let-bound expression is an empty hole, which has unknown
type). However, by gathering constraints from the three uses of x and attempting to unify, we see
that the type hole is unfillable. Rather than arbitrarily privileging one of these uses, as is the case
in languages like OCaml (and which has led to the development of complex heuristics, e.g., using
$$machine learning [Seidel et al. 2017], to avoid misleading programmers), this error is localized, with$$
a !, to the type hole itself, with the error message providing partially consistent solutions as shown.

> [Non-text content omitted at bbox (88.4, 467.3, 397.6, 530.8)]
The user can interactively explore possible error localizations by hovering over a partially
consistent suggestion, which (temporarily) fills the type hole and thus returns the localization
decision to the bidirectional type system. Here, each choice causes a different set of two uses of x to
be marked, e.g., the first and third use for Int -> Int (shown above). Until the choice is finalized,
the type hole continues to operate gradually. Section 4 describes this distinctively neutral approach
to blending local and constraint-based type inference in Hazel, where bidirectional typing is used
to systematically mark erroneous expressions in the program and constraint-based inference (using
entirely standard algorithms, which we do not repeat in this paper) is used exclusively to mark
$$unfillable holes.$$

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 5 -->
Total Type Error Localization and Recovery with Holes
$$68:5$$

2
THE MARKED LAMBDA CALCULUS
To begin to motivate the development of this section, consider Fig. 1, which shows common type
errors as they appear in the Hazel programming environment. These programs are syntactically
$$well-formed but ill-typed.$$

> [Non-text content omitted at bbox (119.7, 146.0, 238.0, 196.0)]
$$(a) Free variable error.$$

> [Non-text content omitted at bbox (248.0, 146.0, 366.3, 196.0)]
(b) Inconsistent types error.

> [Non-text content omitted at bbox (119.7, 216.5, 238.0, 266.5)]
$$(c) Application of a non-lambda.$$

> [Non-text content omitted at bbox (248.0, 216.5, 366.3, 266.5)]
(d) Inconsistent branches error.

Fig. 1. Examples of common type errors.

The key contribution of this section is the marked lambda calculus, a calculus based on the
gradually typed lambda calculus (GTLC) that formalizes the mechanism by which errors like these
can be localized, and how to recover, in all cases, from such errors. Section 2.1 introduces the
syntax, judgemental structure, guiding metatheory, and then goes through the rules, organized
by syntactic form rather than judgement, to build intuition about how the various judgements
relate to one another. All rules and theorems may be found organized by judgement form in the
supplementary appendix for reference, alongside a complete mechanization in the Agda proof
$$assistant [Norell 2007] (discussed in Section 2.2). We intentionally keep the marked lambda calculus$$
minimal, because it is intended to capture the essential idea and introduce a general pattern that
language designers can employ to created marked variants of their own type systems. As an initial
example, we consider a surprisingly subtle combination of features as a more substantial case
study: the combination of destructing let expressions with granular type annotations, in Section 2.3.
Finally, Section 2.4 briefly explores how the system might be extended to more complex judgemental
structures, such as parametric polymorphism.

$$2.1$$
The Core Calculus

The marked lambda calculus is based on the gradually typed lambda calculus [Siek and Taha 2006]
extended with numbers, booleans, pairs, and empty expression holes [Omar et al. 2017b]. Given in
Fig. 2, the syntax consists of two expression languages:

- The unmarked language, which is the original language. Expressions of this language are
called unmarked expressions, denoted by the metavariable e.

- The marked language, which mirrors the structure of the unmarked language but is extended
with error marks. We call expressions of this language marked expressions, denoted ˇe.
In this simple setting, we only need one sort for types, \tau. The base types num and bool classify
number and boolean expressions. The number literal corresponding to the mathematical number n
is given by n, and there is a single arithmetic operation, addition. tt and ff are the boolean values and
if e1 then e2 else e3 is the boolean conditional. Arrow and product types classify lambda abstractions
and pairs, respectively, in the usual way.

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 6 -->
$$68:6$$
Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar

? is a type hole, which we identify with the unknown type from gradual type theory [Siek and
Taha 2006]. Finally, to model the edit state of a program in development,  denotes an empty
expression hole, used to represent syntactically incomplete portions of the program à la Hazelnut
$$[Omar et al. 2017a]. Note, however, that these empty expression holes are not at all semantically$$
critical to the calculus—they are included illustrate how the calculus fits into the larger problem of
modelling incomplete program states and to discuss polymorphic generalization in Section 4.4.

Type
\tau

$$? | num | bool | \tau \to \tau | \tau \times \tau$$
UExp
e

$$x | \lambda x : \tau. e | e e | let x = e in e | n | e + e$$
$$|$$
$$\mathsf{tt} | \mathsf{ff} | if e then e else e | (e,e) | \pi_1e | \pi_2e |$$

MExp
$\check{e}$

$$x | \lambda x : \tau. ˇe | ˇe ˇe | let x = ˇe in ˇe | n | ˇe + ˇe$$
$$|$$
$$\mathsf{tt} | \mathsf{ff} | if ˇe then ˇe else ˇe | (e,ˇ ˇe) | \pi_1 ˇe | \pi_2 ˇe |$$

$$|$$
x$\square$ | $\check{e}$≁

$$|$$
$$\lambda x : \tau. ˇe_{:} | \lambda x : \tau. ˇe$$
⇐
$$^{\triangleright} \not\to | \check{e}$$
$$\Rightarrow$$
$$\triangleright_{ \not\to} \check{e}$$
$$|$$
if ˇe then ˇe else ˇe\not\sqcap

$$|$$
$$(e,ˇ ˇe)$$
⇐
$$\triangleright_{\not\times} | \pi_1\check{e}$$
$$\Rightarrow$$
$$\triangleright_{\not\times} | \pi_2\check{e}$$
$$\Rightarrow$$
$$\triangleright_{\not\times}$$

$$Fig. 2. Syntax of the marked lambda calculus.$$

The key operation is marking, which transforms an unmarked expression into a marked expres-
sion, inserting error marks where appropriate. This corresponds to a type checking process with
error localization and recovery. The marked language may then serve as a foundation for other
semantic services, such as constraint-based inference (as discussed in Section 4). Intuitively, each of
the mark forms corresponds to a different kind of error message that might be shown by an editor
or emitted by a compiler. Note that we do not specify what the error message should say in this
$$paper.$$
Throughout the remainder of this section, as we formulate marking for the GTLC, we will
motivate and give precise semantics for each error mark. Furthermore, when the core is extended,
new marks may be needed, as we discuss below. As we shall see, the rules for marking may
be systematically derived by considering the error cases, yielding a recipe for developing error
localization and recovery semantics for gradual, bidirectional type systems in general.
Before giving any of the rules, let us summarize the overall judgemental structure of the calculus.
Note that colors in the judgement forms below are entirely redundant reading aids—color has no
semantic significance.
As our starting point, types classify unmarked expressions by a completely standard bidirectional
type system [Dunfield and Krishnaswami 2019; Pierce and Turner 2000], which employs two
mutually defined judgments. Type synthesis, written \Gamma ⊢𝑈 e ⇒ \tau , establishes that, under the typing
context \Gamma, the expression e synthesizes or locally infers the type\tau. Type analysis, written \Gamma ⊢𝑈 e ⇐ \tau ,
states that the expression e may appear where an expression of type \tau is expected.
The marked language possesses its own type system, also formulated bidirectionally. We write

\Gamma ⊢𝑀 ˇe ⇒ \tau for synthesis and \Gamma ⊢𝑀 ˇe ⇐ \tau for analysis (in addition to the color difference, note the
subscript on the turnstile to distinguish marked from unmarked typing).
Finally, the marking judgment is also of bidirectional nature. The synthetic marking judgment

\Gamma ⊢ e ↬ ˇe ⇒ \tau establishes that, under the context \Gamma, the unmarked expression e is “marked into”
the marked expression ˇe, which synthesizes type \tau. Analogously, the analytic marking judgment
\Gamma ⊢ e ↬ ˇe ⇐ \tau states that e is marked into ˇe, which analyzes against \tau.

$$Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024.$$

---

<!-- Page 7 -->
Total Type Error Localization and Recovery with Holes
$$68:7$$

How can we ensure that the marking procedure is correctly defined? There are two critical
metatheorems that guide us as we continue. The first is a totality of marking:

$$Theorem 2.1 (Marking Totality).$$
$$(1) For all \Gamma and e, there exist ˇe and \tau such that \Gamma \vdash e ↬ ˇe \Rightarrow \tau and \Gamma \vdash𝑀 ˇe \Rightarrow \tau .$$
$$(2) For all \Gamma, e, and \tau, there exists ˇe such that \Gamma \vdash e ↬ ˇe \Leftarrow \tau and \Gamma \vdash𝑀 ˇe \Leftarrow \tau .$$

That is, we may mark any syntactically well-formed program in any context, resulting in a
$$well-typed marked program.$$
Furthermore, since error marks are effectively annotations on top of the program, marking
should preserve syntactic structure modulo those marks. Fig. 3 gives part of the definition of mark
erasure, which converts marked expressions back into unmarked ones by removing error marks.

$$^{\square}$$
$$=$$


x$\square$
$$=$$
x
$$(\lambda x : \tau. ˇe)\square$$
$$=$$
$$\lambda x : \tau. (\check{e}\square)$$
$$(\check{e}1 ˇe2)^{\square}$$
$$=$$
$$(\check{e}\square$$
$$1 ) (\check{e}^{\square}$$
$$^{2} )$$
...

$$x^{\square}$$

$\square$
$$=$$
x

$$\lambda x : \tau. ˇe_{:}$$

$\square$
$$=$$
$$\lambda x : \tau. (\check{e}\square)$$

$$\lambda x : \tau. ˇe$$
⇐
$$\triangleright_{\not\to}$$

$\square$
$$=$$
$$\lambda x : \tau. (\check{e}\square)$$
$$(\check{e}1$$
$$\Rightarrow$$
$$\triangleright_{ \not\to} \check{e}2)^{\square}$$
$$=$$
$$(\check{e}\square$$
$$1 ) (\check{e}^{\square}$$
$$^{2} )$$

if ˇe1 then ˇe2 else ˇe3\not\sqcap

$\square$
$$=$$
$$if (\check{e}\square$$
$$1 ) then (\check{e}^{\square}$$
$$2 ) else (\check{e}^{\square}$$
$$^{3} )$$

$$(\check{e}1, ˇe2)$$
⇐
$$\triangleright_{\not\times}$$

$\square$
$$=$$
$$(\check{e}\square$$
$$_{1} , ˇe^{\square}$$
$$^{2} )$$
$$(\pi_1\check{e}$$
$$\Rightarrow$$
$$\triangleright_{\not\times})\square$$
$$=$$
$$\pi_1(\check{e}\square)$$
$$(\pi_2\check{e}$$
$$\Rightarrow$$
$$\triangleright_{\not\times})\square$$
$$=$$
$$\pi_2(\check{e}\square)$$

$\check{e}$≁

$\square$
$$=$$
$\check{e}$$\square$$$ Fig. 3. Mark erasure (selected) $$Then, Theorem 2.2 provides the necessary well-formedness criterion for marking.$$ Theorem 2.2 (Marking Well-Formedness). $$$$ (1) If \Gamma ⊢ e ↬ ˇe ⇒ \tau , then \Gamma ⊢𝑀 ˇe ⇒ \tau and ˇe□ = e. $$$$ (2) If \Gamma ⊢ e ↬ ˇe ⇐ \tau , then \Gamma ⊢𝑀 ˇe ⇐ \tau and ˇe□ = e. $$Together, these metatheorems imply that to go from a standard bidirectional system for the
unmarked language to a marking system, we need to handle all possible failure modes with
appropriate marks and marking logic (otherwise totality would be violated) and without otherwise
changing the program (otherwise well-formedness would be violated). Now, let us consider each
form in turn.$$ 2.1.1 $$Numbers. To start, consider the simple case of numbers. Because of subsumption, which
is discussed in more detail next, we need only define a synthesis rule for unmarked numbers, in
which number literals synthesize the type num:
USNum$$ \Gamma ⊢𝑈 n ⇒ num $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 8 -->$$ 68:8 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar How should numbers be marked? Straightforwardly, we simply give the same number as a
marked expression, synthesizing again num. No type errors may occur in a just single number, so
we only need the following rules for marking numbers and typing the results: MKSNum$$ \Gamma ⊢ n ↬ n ⇒ num $$MSNum$$ \Gamma ⊢𝑀 n ⇒ num $$For addition expressions, the type of both operands should be num. To denote this in a bidi-
rectional system, they are analyzed against num, giving the following typing rule for unmarked
addition expressions:$$ USPlus $$$$ \Gamma ⊢𝑈 e1 ⇐ num $$$$ \Gamma ⊢𝑈 e2 ⇐ num $$$$ \Gamma ⊢𝑈 e1 + e2 ⇒ num $$The marking rule parallels USPlus closely. Since an expected type for each operand is known,
we shift the responsibility for any type errors to them. Hence, we recursively mark each operand
in analytic mode and rebuild the marked addition expression. The typing rule for marked addition
expressions then mirrors USPlus exactly.$$ MKSPlus $$\Gamma \vdash e1 ↬ ˇe1 \Leftarrow num
\Gamma \vdash e2 ↬ ˇe2 \Leftarrow num$$ \Gamma ⊢ e1 + e2 ↬ ˇe1 + ˇe2 ⇒ num $$$$ MSPlus $$$$ \Gamma ⊢𝑀 ˇe1 ⇐ num $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ num $$$$ \Gamma ⊢𝑀 ˇe1 + ˇe2 ⇒ num $$$$ 2.1.2 $$Subsumption. Only synthetic rules are necessary for typing numbers and addition because
of subsumption, given below, which states that if an expression synthesizes a type, it may also be
analyzed against that type or any consistent type. UASubsume$$ \Gamma ⊢𝑈 e ⇒ \tau′ $$\tau ∼ \tau′
e subsumable$$ \Gamma ⊢𝑈 e ⇐ \tau $$We rely on the notion of type consistency from gradual type theory, which defines a reflexive and
symmetric (but not transitive) relation between types, writing \tau1 ∼ \tau2 to mean that \tau1 is consistent
with \tau2. Defined in Fig. 4, this replaces the notion of type equality to relate the unknown type to all
other types. \tau1 ∼ \tau2 \tau1 is consistent with \tau2 TCUnknown1 ? ∼ \tau TCUnknown2 \tau ∼ ?$$ TCRefl $$\tau ∼ \tau TCArr
\tau1 ∼ \tau′
1
\tau2 ∼ \tau′
2 \tau1 \to \tau2 ∼ \tau′$$ 1 → \tau′ $$2 TCProd
\tau1 ∼ \tau′
1
\tau2 ∼ \tau′
2 \tau1 \times \tau2 ∼ \tau′$$ 1 × \tau′ $$2$$ Fig. 4. Type consistency. $$Hence, when checking n against a known expected type, subsumption checks that the type is
consistent with num, the type that n synthesizes. This succeeds for ? and num.
We also restrict the usage of subsumption to “subsumable” syntactic forms, written e subsumable.
This judgment is defined for all syntactic forms except lambda abstractions, conditionals, and pairs,
the only ones with both synthesis and analysis rules (see below). In other words, we restrict
subsumption to be the rule of “last resort”, which is necessary to establish that marking and typing
are deterministic (see Theorem 2.4).$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 9 -->
Total Type Error Localization and Recovery with Holes$$ 68:9 $$Now, to define analytic marking on forms without explicit analytic typing rules, we also need
subsumption rules for marking and marked expression typing. Note that we define an analogous
notion of “subsumability” for marked expressions, written ˇe subsumable. MKASubsume$$ \Gamma ⊢ e ↬ ˇe ⇒ \tau′ $$\tau ∼ \tau′
e subsumable$$ \Gamma ⊢ e ↬ ˇe ⇐ \tau $$MASubsume$$ \Gamma ⊢𝑀 ˇe ⇒ \tau′ $$\tau ∼ \tau′
$\check{e}$ subsumable$$ \Gamma ⊢𝑀 ˇe ⇐ \tau $$But what happens when the synthesized type of an expression is not consistent with the expected
type, i.e., that the premise \tau ∼ \tau′ fails? Recalling the example of Fig. 1b, subsumption would be
used to analyze \mathsf{tt} against num when checking \mathsf{tt} + 1, which fails since num ≁ bool—UASubsume
does not apply. At this point, traditional typing semantics would simply fail the type checking
process. MKASubsume would also not be applicable, leaving marking undefined in those cases.
To satisfy marking totality, such a possibility motivates an inconsistent type mark $\check{e}$≁, which is
applied when the synthesized type of ˇe is inconsistent with the expected type: MKAInconsistentTypes$$ \Gamma ⊢ e ↬ ˇe ⇒ \tau′ $$\tau ≁ \tau′
e subsumable \Gamma \vdash e ↬ $\check{e}$≁ \Leftarrow \tau MAInconsistentTypes$$ \Gamma ⊢𝑀 ˇe ⇒ \tau′ $$\tau ≁ \tau′
$\check{e}$ subsumable$$ \Gamma ⊢𝑀 eˇ≁ ⇐ \tau $$Observe that the premises of MKAInconsistentTypes are identical to those of MKASubsume,
except that \tau ≁ \tau′. By marking an error, the type checking process may carry on and provide
semantic feedback for the rest of the program.$$ 2.1.3 $$Variables. Let us now consider the case of variables. Typing in the unmarked language is
standard, and because of subsumption, only a synthetic rule is required: USVar$$ x : \tau ∈ \Gamma $$$$ \Gamma ⊢𝑈 x ⇒ \tau $$That is, if x is bound to a type in the typing context, it synthesizes that type. Straightforwardly,
marking converts an unmarked variable into the same variable via the following rules: MKSVar$$ x : \tau ∈ \Gamma $$$$ \Gamma ⊢ x ↬ x ⇒ \tau $$MSVar$$ x : \tau ∈ \Gamma $$$$ \Gamma ⊢𝑀 x ⇒ \tau $$However, consider the case that a variable, such as y in Fig. 1a, is not bound. Similar to above,
USVar would not apply. A total marking procedure should, however, report the error and continue,
motivating a free variable mark x$\square$ and the accompanying rules: MKSFree$$ x ∉ dom(\Gamma) $$$$ \Gamma ⊢ x ↬ x□ ⇒ ? $$MSFree$$ x ∉ dom(\Gamma) $$$$ \Gamma ⊢𝑀 x□ ⇒ ? $$A free variable is marked as such, and since nothing may be said about their types, we synthesize
the unknown type. As with the inconsistent type mark, this allows type checking to proceed, with
usage of the free variable permitted in any expression.$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 10 -->$$ 68:10 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar$$ 2.1.4 $$Lambda Abstractions. Unlike numbers and variables, there are explicit synthesis and analysis
rules for unmarked lambda abstractions. This is because expected input and output types are
known, and we may verify that the type annotation and body match them. USLam$$ \Gamma, x : \tau1 ⊢𝑈 e ⇒ \tau2 $$$$ \Gamma ⊢𝑈 \lambdax : \tau1. e ⇒ \tau1 → \tau2 $$UALam$$ \tau3 ▶_{→} \tau1 → \tau2 $$\tau ∼ \tau1$$ \Gamma, x : \tau ⊢𝑈 e ⇐ \tau2 $$$$ \Gamma ⊢𝑈 \lambdax : \tau. e ⇐ \tau3 $$The synthesis rule is standard. Analysis employs the judgment \tau \triangleright_{\to} \tau1 \to \tau2, which establishes
that \tau is a matched arrow type [Cimini and Siek 2016], i.e., it may be considered an arrow type.
Defined in Fig. 5, this notion is purely a technical mechanism to avoid duplication of rules related$$ to arrow types [Siek et al. 2015]. $$$$ \tau ▶_{→} \tau1 → \tau2 \tau has matched arrow type \tau1 → \tau2 $$TMAUnknown$$ ? ▶_{→} ? → ? $$TMAArr$$ \tau1 → \tau2 ▶_{→} \tau1 → \tau2 $$Fig. 5. Matched arrow types. The synthesis rule for marking intuitively follows USLam closely. We recursively mark the body
with an extended context and construct a new marked lambda abstraction:
MKSLam$$ \Gamma, x : \tau1 ⊢ e ↬ ˇe ⇒ \tau2 $$$$ \Gamma ⊢ \lambdax : \tau1. e ↬ \lambdax : \tau1. ˇe ⇒ \tau1 → \tau2 $$MSLam$$ \Gamma, x : \tau1 ⊢𝑀 ˇe ⇒ \tau2 $$$$ \Gamma ⊢𝑀 \lambdax : \tau1. ˇe ⇒ \tau1 → \tau2 $$Similarly, we construct corresponding analytic rules: MKALam1$$ \tau3 ▶_{→} \tau1 → \tau2 $$\tau ∼ \tau1$$ \Gamma, x : \tau ⊢ e ↬ ˇe ⇐ \tau2 $$$$ \Gamma ⊢ \lambdax : \tau. e ↬ \lambdax : \tau. ˇe ⇐ \tau3 $$MALam1$$ \tau3 ▶_{→} \tau1 → \tau2 $$\tau ∼ \tau1$$ \Gamma, x : \tau ⊢𝑀 ˇe ⇐ \tau2 $$$$ \Gamma ⊢𝑀 \lambdax : \tau. ˇe ⇐ \tau3 $$However, recalling totality, we look again to the premises of UALam to see what type errors
may arise. First, what if \tau3 is not a matched arrow type? This would be the case if it were num,
for example. The lambda abstraction’s synthesized type would indeed be inconsistent with the
expected type, but this case is slightly distinct from that of the inconsistent types mark: the lambda
expression is in analytic position. Instead, we mark $\check{e}$
\Leftarrow
\triangleright_{ \not\to} to indicate that an expression of the
non-matched arrow type \tau3 was expected, but a lambda abstraction was encountered. MKALam2$$ \tau3 ▶_{ \not\to} $$$$ \Gamma, x : \tau ⊢ e ↬ ˇe ⇐ ? $$$$ \Gamma ⊢ \lambdax : \tau. e ↬ \lambdax : \tau. ˇe $$\Leftarrow$$ ▶_{ \not\to} ⇐ \tau3 $$MALam2$$ \tau3 ▶_{ \not\to} $$$$ \Gamma, x : \tau ⊢𝑀 ˇe ⇐ ? $$$$ \Gamma ⊢𝑀 \lambdax : \tau. ˇe $$\Leftarrow$$ ▶_{ \not\to} ⇐ \tau3 $$Though no expected output type is known, we still need to check and mark the body; it is thus
analyzed against the unknown type in MKALam2. It is possible to instead synthesize the body, but
we choose analysis so that the body is always in analytic mode. The guiding design principle in
this decision is a notion of “conservation of mode,” but it is not critical to the calculus.
Note that in this example language, the distinction from the inconsistent type mark is of reduced
significance—all expressions synthesize a type. However, the addition of unannotated lambda
abstractions, for example, would necessitate such a distinction.$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 11 -->
Total Type Error Localization and Recovery with Holes$$ 68:11 $$Another error arises when \tau3 \triangleright_{\to} \tau1 \to \tau2, but \tau ≁ \tau1, i.e., the actual type annotation for x is
inconsistent with the expected input type. The inconsistent ascription mark \lambda x : \tau. ˇe_{:} indicates
exactly this error, and we add a final pair of analytic rules: MKALam3$$ \tau3 ▶_{→} \tau1 → \tau2 $$\tau ≁ \tau1$$ \Gamma, x : \tau ⊢ e ↬ ˇe ⇐ \tau2 $$$$ \Gamma ⊢ \lambdax : \tau. e ↬ \lambdax : \tau. ˇe_{:} ⇐ \tau3 $$MALam3$$ \tau3 ▶_{→} \tau1 → \tau2 $$\tau ≁ \tau1$$ \Gamma, x : \tau ⊢𝑀 ˇe ⇐ \tau2 $$$$ \Gamma ⊢𝑀 \lambdax : \tau. ˇe_{:} ⇐ \tau3 $$$$ 2.1.5 $$Applications. In the unmarked language, only a synthesis rule is necessary for applications: USAp$$ \Gamma ⊢𝑈 e1 ⇒ \tau $$$$ \tau ▶_{→} \tau1 → \tau2 $$$$ \Gamma ⊢𝑈 e2 ⇐ \tau1 $$$$ \Gamma ⊢𝑈 e1 e2 ⇒ \tau2 $$Following the same methodology up to this point, we have the following marking and typing rules: MKSAp1$$ \Gamma ⊢ e1 ↬ ˇe1 ⇒ \tau $$$$ \tau ▶_{→} \tau1 → \tau2 $$\Gamma \vdash e2 ↬ ˇe2 \Leftarrow \tau1$$ \Gamma ⊢ e1 e2 ↬ ˇe1 ˇe2 ⇒ \tau2 $$MSAp1$$ \Gamma ⊢𝑀 ˇe1 ⇒ \tau $$$$ \tau ▶_{→} \tau1 → \tau2 $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ \tau1 $$$$ \Gamma ⊢𝑀 ˇe1 ˇe2 ⇒ \tau2 $$Again, to satisfy totality, we must consider the case when \tau is not a matched arrow type, such
as in the example of Fig. 1c. There is no expected type for the argument, so we perform analytic
marking on e2 against the unknown type. In this case, it is not quite right to mark e1 with the
inconsistent type mark; rather than any single type, it is any member of the family of arrow types
that is expected. For such a “constrained” synthetic mode, we use a specialized mark $\check{e}$$$ ⇒ $$$$ ▶ \not\to, which $$indicates that ˇe was expected to be a function—but was not. The output type is unknown, so the
entire expression synthesizes the unknown type. MKSAp2$$ \Gamma ⊢ e1 ↬ ˇe1 ⇒ \tau $$$$ \tau ▶_{ \not\to} $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇐ ? $$\Gamma \vdash e1 e2 ↬ $\check{e}$1$$ ⇒ $$$$ ▶_{ \not\to} eˇ2 ⇒ ? $$MSAp2$$ \Gamma ⊢𝑀 ˇe1 ⇒ \tau $$$$ \tau ▶_{ \not\to} $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ ? $$$$ \Gamma ⊢𝑀 eˇ $$$$ ⇒ $$$$ ▶_{ \not\to} eˇ ⇒ ? $$It is natural to extend this approach to other elimination forms that require the handling of
unmatched types, such as products. Indeed, the same approach is taken for projections below.
Another similar approach might indicate the same kind of error but mark the entire application.$$ 2.1.6 $$Booleans. The boolean values are similar to numbers:
USTrue$$ \Gamma ⊢𝑈 tt ⇒ bool $$MKSTrue$$ \Gamma ⊢ tt ↬ tt ⇒ bool $$MSTrue$$ \Gamma ⊢𝑀 tt ⇒ bool $$$$ USFalse $$$$ \Gamma ⊢𝑈 ff ⇒ bool $$$$ MKSFalse $$$$ \Gamma ⊢ ff ↬ ff ⇒ bool $$$$ MSFalse $$$$ \Gamma ⊢𝑀 ff ⇒ bool $$Conditionals, however, present a more interesting case. In the unmarked language, we have both
explicit synthetic and analytic rules: USIf$$ \Gamma ⊢𝑈 e1 ⇐ bool $$$$ \Gamma ⊢𝑈 e2 ⇒ \tau1 $$$$ \Gamma ⊢𝑈 e3 ⇒ \tau2 $$\tau3 = \tau1 \sqcap \tau2$$ \Gamma ⊢𝑈 if e1 then e2 else e3 ⇒ \tau3 $$UAIf$$ \Gamma ⊢𝑈 e1 ⇐ bool $$$$ \Gamma ⊢𝑈 e1 ⇐ \tau $$$$ \Gamma ⊢𝑈 e2 ⇐ \tau $$\Gamma \vdash𝑈 if e1 then e2 else e3 \Leftarrow \tau$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 12 -->$$ 68:12 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar In synthetic position, conditionals synthesize the meet of the branch types \tau1 and \tau2, which we
define inductively in Fig. 6. We choose the “more specific” type of the two. In analytic position,
since there is an expected type for both branches, we shift the blame for any errors to them. \tau1 \sqcap \tau2 is a partial metafunction defined as follows: ? \sqcap\tau$$ = $$\tau
\tau \sqcap ?$$ = $$\tau
num \sqcap num$$ = $$num$$ bool ⊓ bool $$$$ = $$$$ bool $$$$ (\tau1 → \tau2) ⊓ (\tau′ $$$$ 1 → \tau′ $$$$ 2) $$$$ = $$$$ (\tau1 ⊓ \tau′ $$1. \to (\tau2 \sqcap \tau′$$ 2) $$$$ (\tau1 × \tau2) ⊓ (\tau′ $$$$ 1 × \tau′ $$$$ 2) $$$$ = $$$$ (\tau1 ⊓ \tau′ $$1. \times (\tau2 \sqcap \tau′$$ 2) $$$$ Fig. 6. Type meet. $$Following USIf and UAIf, we may derive the following marking and typing rules. MKSIf$$ \Gamma ⊢ e1 ↬ ˇe1 ⇐ bool $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇒ \tau1 $$$$ \Gamma ⊢ e3 ↬ ˇe3 ⇒ \tau2 $$\tau3 = \tau1 \sqcap \tau2 \Gamma \vdash if e1 then e2 else e3 ↬ if ˇe1 then ˇe2 else ˇe3 \Rightarrow \tau3 MSIf$$ \Gamma ⊢𝑀 ˇe1 ⇐ bool $$$$ \Gamma ⊢𝑀 ˇe2 ⇒ \tau1 $$$$ \Gamma ⊢𝑀 ˇe3 ⇒ \tau2 $$\tau3 = \tau1 \sqcap \tau2 \Gamma \vdash𝑀 if ˇe1 then ˇe2 else ˇe3 \Rightarrow \tau3 MKAIf$$ \Gamma ⊢ e1 ↬ ˇe1 ⇐ bool $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇐ \tau $$$$ \Gamma ⊢ e3 ↬ ˇe3 ⇐ \tau $$\Gamma \vdash if e1 then e2 else e3 ↬ if ˇe1 then ˇe2 else ˇe3 \Leftarrow \tau MAIf$$ \Gamma ⊢𝑀 ˇe1 ⇐ bool $$$$ \Gamma ⊢𝑀 ˇe1 ⇐ \tau $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ \tau $$\Gamma \vdash𝑀 if ˇe1 then ˇe2 else ˇe3 \Leftarrow \tau However, in synthetic position, it may be the case that the two branch types have no meet.
This occurs, in fact, when they are inconsistent, motivating the the inconsistent branches mark
if ˇe then ˇe else ˇe\not\sqcap. Then, adding the following rules ensures totality on conditionals: MKSInconsistentBranches$$ \Gamma ⊢ e1 ↬ ˇe1 ⇐ bool $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇒ \tau1 $$$$ \Gamma ⊢ e3 ↬ ˇe3 ⇒ \tau2 $$\tau1 ≁ \tau2 \Gamma \vdash if e1 then e2 else e3 ↬ if ˇe1 then ˇe2 else ˇe3\not\sqcap \Rightarrow ? MSInconsistentBranches$$ \Gamma ⊢𝑀 ˇe1 ⇐ bool $$$$ \Gamma ⊢𝑀 ˇe2 ⇒ \tau1 $$$$ \Gamma ⊢𝑀 ˇe3 ⇒ \tau2 $$\tau1 ≁ \tau2 \Gamma \vdash𝑀 if ˇe1 then ˇe2 else ˇe3\not\sqcap \Rightarrow ? As previously mentioned, we do not prescribe any single localization design as “correct”, and
the framework freely allows for other approaches. For example, as discussed in the introduction,
we may choose to regard the first branch as “correct” and localize any errors to the second. The$$ following rule formalizes such a design: $$MKSIf’$$ \Gamma ⊢ e1 ↬ ˇe1 ⇐ bool $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇒ \tau $$$$ \Gamma ⊢ e3 ↬ ˇe3 ⇐ \tau $$\Gamma \vdash if e1 then e2 else e3 ↬ if ˇe1 then ˇe2 else ˇe3 \Rightarrow \tau$$ 2.1.7 $$Pairs. At this point, the introduction of pairs expressions and the necessary projection
operators poses no great challenge. Explicit synthesis and analysis rules govern the former. USPair$$ \Gamma ⊢𝑈 e1 ⇒ \tau1 $$$$ \Gamma ⊢𝑈 e2 ⇒ \tau2 $$$$ \Gamma ⊢𝑈 (e1,e2) ⇒ \tau1 × \tau2 $$UAPair$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢𝑈 e1 ⇐ \tau1 $$$$ \Gamma ⊢𝑈 e2 ⇐ \tau2 $$$$ \Gamma ⊢𝑈 (e1,e2) ⇐ \tau $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 13 -->
Total Type Error Localization and Recovery with Holes$$ 68:13 $$In similar fashion to above, we may derive marking rules from these in an intuitive manner: MKSPair$$ \Gamma ⊢ e1 ↬ ˇe1 ⇒ \tau1 $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇒ \tau2 $$$$ \Gamma ⊢ (e1,e2) ↬ (eˇ1, ˇe2) ⇒ \tau1 × \tau2 $$MSPair$$ \Gamma ⊢𝑀 ˇe1 ⇒ \tau1 $$$$ \Gamma ⊢𝑀 ˇe2 ⇒ \tau2 $$$$ \Gamma ⊢𝑀 (eˇ1, ˇe2) ⇒ \tau1 × \tau2 $$MKAPair1$$ \tau ▶_{×} \tau1 × \tau2 $$\Gamma \vdash e1 ↬ ˇe1 \Leftarrow \tau1
\Gamma \vdash e2 ↬ ˇe2 \Leftarrow \tau2$$ \Gamma ⊢ (e1,e2) ↬ (eˇ1, ˇe2) ⇐ \tau $$MAPair1$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢𝑀 ˇe1 ⇐ \tau1 $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ \tau2 $$$$ \Gamma ⊢𝑀 (eˇ1, ˇe2) ⇐ \tau $$However, as when analyzing a lambda abstraction against a non-matched arrow type, the type
against which a pair is analyzed may not match any product type. We solve this by adding an error$$ mark (eˇ1, ˇe2) $$\Leftarrow$$ ▶_{\not\times} and the corresponding rules: $$MKAPair2$$ \tau ▶_{\not\times} $$$$ \Gamma ⊢ e1 ↬ ˇe1 ⇐ ? $$$$ \Gamma ⊢ e2 ↬ ˇe2 ⇐ ? $$$$ \Gamma ⊢ (e1,e2) ↬ (eˇ1, ˇe2) $$\Leftarrow$$ ^{▶}\not\times ⇐ \tau $$MAPair2$$ \tau ▶_{\not\times} $$$$ \Gamma ⊢𝑀 ˇe1 ⇐ ? $$$$ \Gamma ⊢𝑀 ˇe2 ⇐ ? $$$$ \Gamma ⊢𝑀 (eˇ1, ˇe2) $$\Leftarrow$$ ^{▶}\not\times ⇐ \tau $$As the elimination form for products, projections are handled in a similar manner as applications.
In the interest of space, we give only the rules for the left projection operator; right projections are$$ governed analogously. $$USProjL$$ \Gamma ⊢𝑈 e ⇒ \tau $$$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢𝑈 \pi1e ⇒ \tau1 $$MKSProjL1$$ \Gamma ⊢ e ↬ ˇe ⇒ \tau $$$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢ \pi1e ↬ \pi1 ˇe ⇒ \tau1 $$MSProjL1$$ \Gamma ⊢𝑀 ˇe ⇒ \tau $$$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢𝑀 \pi1 ˇe ⇒ \tau1 $$In the case that the subject of the projection does not synthesize a matched product type, we
mark with an error, written \pi_1$\check{e}$$$ ⇒ $$$$ ▶\not\times: $$MKSProjL2$$ \Gamma ⊢ e ↬ ˇe ⇒ \tau $$$$ \tau ▶_{\not\times} $$$$ \Gamma ⊢ \pi1e ↬ \pi1eˇ $$$$ ⇒ $$$$ ^{▶}\not\times ⇒ ? $$MSProjL2$$ \Gamma ⊢𝑀 ˇe ⇒ \tau $$$$ \tau ▶_{\not\times} $$$$ \Gamma ⊢𝑀 \pi1eˇ $$$$ ⇒ $$$$ ^{▶}\not\times ⇒ ? $$$$ 2.1.8 $$Holes. For completeness, we finish the development of the marked lambda calculus on the
extended GTLC with the marking of empty holes, which are never marked (see Sec. 4 for marking$$ unfillable holes using constraint solving). $$$$ USHole $$$$ \Gamma ⊢𝑈  ⇒ ? $$$$ MKSHole $$$$ \Gamma ⊢  ↬  ⇒ ? $$$$ MSHole $$$$ \Gamma ⊢𝑀  ⇒ ? $$$$ 2.1.9 $$Additional Metatheorems. To conclude this section, we present two more metatheorems that
help ensure correctness of the system. Although Theorem 2.2 guarantees that marking does not
change the syntactic structure of a program, it makes no statement about the presence of error
marks in the resulting marked program. Theorem 2.3 establishes that well-typed expressions are
left unmarked and ill-typed expressions have at least one mark.$$ Theorem 2.3 (Marking of Well-Typed/Ill-Typed Expressions). $$$$ (1)(a) If \Gamma ⊢𝑈 e ⇒ \tau and \Gamma ⊢ e ↬ ˇe ⇒ \tau , then ˇe markless. $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 14 -->$$ 68:14 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar$$ (b) If \Gamma ⊢𝑈 e ⇐ \tau and \Gamma ⊢ e ↬ ˇe ⇐ \tau , then ˇe markless. $$$$ (2)(a) If there does not exist \tau such that \Gamma ⊢𝑈 e ⇒ \tau , then for all ˇe and \tau′ such that \Gamma ⊢ e ↬ ˇe ⇒ \tau′ , $$it is not the case that ˇe markless. (b) If there does not exist \tau such that \Gamma \vdash𝑈 e \Leftarrow \tau , then for all ˇe and \tau′ such that \Gamma \vdash e ↬ ˇe \Leftarrow \tau′ ,
it is not the case that ˇe markless. Finally, no less importantly, marking is deterministic. This is given by Theorem 2.4.$$ Theorem 2.4 (Marking Unicity). $$$$ (1) If \Gamma ⊢ e ↬ ˇe1 ⇒ \tau1 and \Gamma ⊢ e ↬ ˇe2 ⇒ \tau2 , then ˇe1 = ˇe2 and \tau1 = \tau2. $$$$ (2) If \Gamma ⊢ e ↬ ˇe1 ⇐ \tau and \Gamma ⊢ e ↬ ˇe2 ⇐ \tau , then ˇe1 = ˇe2. $$Together, totality and unicity give that marking may be implemented as a total function. Indeed,
given the algorithmic nature of bidirectional typing, it is fairly direct to implement these rules.$$ 2.2 $$Agda Mechanization
The semantics and metatheory presented above have been fully mechanized in the Agda proof
assistant. The mechanization [Zhao et al. 2023] additionally includes the decoupled Hazelnut
action semantics described in Section 3.2. Though the mechanization’s documentation contains
more detailed discussion regarding technical decisions made therein, we highlight some important
aspects here.
The standard approach of modeling judgments as inductive datatypes and rules as constructors
for those datatypes is taken. By representing marked expressions with implicitly typed terms, we
get part of Theorem 2.2 for free from the definition of marking. For the convenience of readers
interested in browsing the mechanization, as possible, rule names match those presented here.$$ 2.3 $$Destructuring Let with Type Annotated Composite Patterns To ease the use of products and other datatypes, many languages feature destructuring bindings. In a
typed setting, we may want to granularly add type annotations in patterns as well. In a bidirectional
setting, as it turns out, this combination of features is surprisingly tricky to get right! Let us add let
expressions and simple patterns, writing _ for the wildcard pattern, x for a variable pattern, and$$ (𝑝1, 𝑝2) for a pair: $$UExp
e$$ · · · | let 𝑝 = e in e $$UPat
𝑝$$ _ | x | (𝑝, 𝑝) | 𝑝 : \tau $$Consider the following program:$$ let (a,b) = (1, 2) in e $$To type this, one approach is to synthesize a type from the pattern and analyze the definition
against that type. However, this may run afoul of user expectation, which might reasonably suppose
it to be equivalent to the expanded expression let a = 1 in let b = 2 in e. In the original, the pattern
synthesizes the type ? \times ?, and (1, 2) is analyzed against it, hence 1 and 2 are each analyzed against
?. In the expanded version, however, they are typed in synthetic mode.
Though it is benign in this example, there is a subtle semantic distinction: synthetic mode imposes
no type constraints, whereas analytic mode imposes a trivial type constraint. This manifests when
expressions may have internal type inconsistencies, as in the following: let a = if \mathsf{tt} then 1 else \mathsf{ff} in e If the pattern a suggests that the conditional is in synthetic position, it will be marked with an
inconsistent branches error mark following our development above. If instead it is in analytic$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 15 -->
Total Type Error Localization and Recovery with Holes$$ 68:15 $$position against the unknown type, each branch is checked independently against this trivial
constraint, and no mark will be produced.
To remedy this situation and preserve the semantic distinction between synthesis and analysis
against the unknown type, we introduce a pattern annotation form, written 𝑝 : \tau, which allows the
explicit imposition of typing constraints. That is, the absence of any type annotation on a variable
pattern places the corresponding definition in synthetic mode, while the programmer may impose
typing constraints—the trivial constraint, if they wish—on the definition. As illustration, consider$$ the following program: $$$$ let (a,b : ?) = (if tt then 1 else ff, if tt then 2 else ff) in e $$Since a has no constraint, the left component is in synthetic position, leading to an inconsistent
branches error. The type annotation on b puts the right component in analytic mode against the
unknown type, leading to no error marks.
This is achieved by adding a “switch type”, denoted ?\Rightarrow, which exists entirely to trigger a “switch”
to synthesis. ?\Rightarrow represents a trivial constraint, instantiated as a type for the sole purpose of using
the existing machinery to propagate the appropriate mode switch to the relevant sub-expression of
the definition. This is expressed by the following rule: UASynSwitch$$ \Gamma ⊢𝑈 e ⇒ \tau $$$$ \Gamma ⊢𝑈 e ⇐ ?⇒ $$This switch type carries over identically to a non-gradual setting, but here we represent it as
a variant of ? as it behaves identically with respect to consistency and our notions of matched$$ arrow/product. $$In the previous example, the unannotated pattern variable a synthesizes ?\Rightarrow, and the annotated
pattern b : ? synthesizes ?. We write \Gamma \vdash𝑈 𝑝 \Rightarrow \tau to say that the pattern 𝑝 synthesizes type \tau. USPVar$$ \Gamma ⊢𝑈 x ⇒ ?⇒ $$USPPair$$ \Gamma ⊢𝑈 𝑝1 ⇒ \tau1 $$$$ \Gamma ⊢𝑈 𝑝2 ⇒ \tau2 $$$$ \Gamma ⊢𝑈 (𝑝1, 𝑝2) ⇒ \tau1 × \tau2 $$USPAnn$$ \Gamma ⊢𝑈 𝑝 ⇐ \tau ⊣ \Gamma′ $$$$ \Gamma ⊢𝑈 𝑝 : \tau ⇒ \tau $$Given by the judgment \Gamma \vdash𝑈 𝑝 \Leftarrow \tau ⊣ \Gamma′ , patterns are also typed analytically, in which case they
produce an output context \Gamma′ that extends \Gamma with bindings introduced by the pattern. Note again
that ?\Rightarrow exists entirely to ensure that sub-expressions of the definition are assigned an appropriate
typing mode—it is never added to the context, i.e., it cannot escape into the rest of the program and
cause body expressions to synthesize accidentally. UAPVar$$ \Gamma ⊢𝑈 x ⇐ \tau ⊣ \Gamma, x : \tau $$UAPPair$$ \tau ▶_{×} \tau1 × \tau2 $$$$ \Gamma ⊢𝑈 𝑝1 ⇐ \tau1 ⊣ \Gamma1 $$$$ \Gamma1 ⊢𝑈 𝑝2 ⇐ \tau2 ⊣ \Gamma2 $$$$ \Gamma ⊢𝑈 (𝑝1, 𝑝2) ⇐ \tau ⊣ \Gamma2 $$UAPAnn$$ \Gamma ⊢𝑈 𝑝 ⇐ \tau′ ⊣ \Gamma′ $$\tau ∼ \tau′$$ \Gamma ⊢𝑈 𝑝 : \tau′ ⇐ \tau ⊣ \Gamma′ $$Synthesis for let expressions is straightforward: we synthesize the type of the definition and
analyze the pattern against it. We then synthesize the body under the new context: USLetPat$$ \Gamma ⊢𝑈 e1 ⇒ \tau1 $$$$ \Gamma ⊢𝑈 𝑝 ⇐ \tau1 ⊣ \Gamma′ $$$$ \Gamma′ ⊢𝑈 e2 ⇒ \tau2 $$$$ \Gamma ⊢𝑈 let 𝑝 = e1 in e2 ⇒ \tau2 $$The analytic rule is similar, with the final premise and conclusion changed to analysis.$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 16 -->$$ 68:16 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar Unfortunately, attempting an analogous marking rule runs into some trouble. We want any type
annotations in the pattern to be canonical, which means analyzing the definition to attribute to it
any inconsistencies. But we still must analyze the pattern, incorporating the definition’s type to
produce the context needed by the body. So we do a “round trip”: analyze the definition against
the pattern’s type, and then the pattern against the definition’s. Since the first analysis establishes
consistency, this second analysis is guaranteed to succeed; we only care about the context produced:
MKSLetPat$$ \Gamma ⊢ 𝑝 ↬ ˇ𝑝 ⇒ \tau𝑝 $$\Gamma \vdash e1 ↬ ˇe1 \Leftarrow \tau𝑝$$ \Gamma ⊢𝑈 e1 ⇒ \tau1 $$$$ \Gamma ⊢𝑈 𝑝 ⇐ \tau1 ⊣ \Gamma′ $$$$ \Gamma′ ⊢ e2 ↬ ˇe2 ⇒ \tau2 $$$$ \Gamma ⊢ let 𝑝 = e1 in e2 ↬ let ˇ𝑝 = ˇe1 in ˇe2 ⇒ \tau2 $$We omit the marking of patterns—they may be derived in the same way as those for expressions
and are governed by similar metatheorems (again, totality guides the derivation). In the analytic
cases, we introduce error marks that parallel to $\check{e}$≁ and $\check{e}$
\Leftarrow$$ ▶\not\times. $$Note that both USLetPat and MKSLetPat assume that the definition synthesizes. In our system
this is always the case, but if we added, for example, unannotated lambda abstractions, we might
wish to relax this restriction. We can freely add variations of the rules where if the definition fails to
synthesize, it is instead analyzed against the synthesized type of the pattern. To avoid an additional
redundant analysis, we would further want to modify the pattern synthesis judgement to produce$$ a context as well. $$Recent work by Yuan et al. [2023] addresses the problem of general pattern matching with typed
holes, providing mechanisms to reason statically about redundancy and exhaustiveness in the
presence of pattern holes. Integrating this work with the marked lambda calculus would employ
error marks indicating inexhaustive matches and redundant patterns.$$ 2.4 $$Parametric Polymorphism and Richer Judgmental Structures To further demonstrate that the judgmental structure of the marked lambda calculus may be applied
to richer typing features, we now explore an extension of the core language developed above to
System F-style parametric polymorphism. Toward this end, we supplement the language in Fig. 7
with type abstractions \Lambda𝛼. e and applications e [\tau]. These operate on forall types ∀𝛼. \tau and type
variables 𝛼, which are governed by a well-formedness judgment, written \Sigma \vdash
𝑈 \tau , in the standard$$ way. $$Type
\tau$$ · · · | ∀𝛼. \tau | 𝛼 $$MType
\ta$\check{u}$$$ · · · | ∀𝛼. ˇ\tau | 𝛼 | 𝛼□ $$UExp
e$$ · · · | \Lambda𝛼. e | e [\tau] $$MExp
$\check{e}$$$ · · · | \Lambda𝛼. ˇe | ˇe [\tauˇ] $$$$ | $$$$ \Lambda𝛼. ˇe $$\Leftarrow$$ ^{▶}̸∀ | eˇ $$$$ ⇒ $$$$ ^{▶}̸∀ [\tauˇ] $$Fig. 7. Extension of the marked lambda calculus for parametric polymorphism Crucially, just as expression variables may be free, arbitrary programs may contain free type
variables; similar to the introduction of both unmarked and marked patterns in the previous
section, we now need separate notions of unmarked and marked types. The latter we denote by the$$ metavariable ˇ\tau. $$A marking judgment, written \Sigma \vdash \tau ↬ ˇ\tau , then, relates the two sorts. It is parameterized over
a context of type variables \Sigma, and most of the rules recurse straightforwardly. When a free type$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 17 -->
Total Type Error Localization and Recovery with Holes$$ 68:17 $$variable 𝛼 is encountered, however, we mark it as such, writing 𝛼$\square$. This gives the following$$ marking and well-formedness rules: $$MKTFree$$ 𝛼 ∉ \Sigma $$$$ \Sigma ⊢ 𝛼 ↬ 𝛼□ $$MTWFFree$$ 𝛼 ∉ \Sigma $$$$ \Sigma ⊢ $$$$ ^{𝑀} 𝛼^{□} $$Just as expression error marks synthesize the unknown type to allow type-checking to continue,
these marked types operate identically to the unknown type with respect to consistency and other
auxiliary notions. Furthermore, we define analogous notions of mark erasure on types, and, as with
pattern marking above, metatheoretic statements ensure their correctness.
The development of marking for type abstractions is similar to that for ordinary lambda abstrac-
tions. The synthetic case is straightforward; in analytic position, if the type being analyzed against
is not a matched forall type, an error is marked: MKATypeLam2$$ \tauˇ ▶_{̸∀} $$$$ \Sigma, 𝛼; \Gamma ⊢ e ↬ ˇe ⇐ ? $$$$ \Sigma; \Gamma ⊢ \Lambda𝛼. e ↬ \Lambda𝛼. ˇe $$\Leftarrow$$ ▶_{̸∀} ⇐ ˇ\tau $$MATypeLam2$$ \tauˇ ▶_{̸∀} $$$$ \Sigma, 𝛼; \Gamma ⊢ $$𝑀 $\check{e}$ \Leftarrow ?$$ \Sigma; \Gamma ⊢ $$$$ 𝑀 \Lambda𝛼. ˇe $$\Leftarrow$$ ▶_{̸∀} ⇐ ˇ\tau $$Likewise, type application mirrors ordinary application: in the case that the expression being
applied does not synthesize a matched forall type, an error is marked. With this, totality of marking
is satisfied.
MKSTypeAp2$$ \Sigma; \Gamma ⊢ e ↬ ˇe ⇒ ˇ\tau $$$$ \Sigma ⊢ \tau2 ↬ ˇ\tau2 $$$$ \tauˇ ▶_{̸∀} $$$$ \Sigma; \Gamma ⊢ e [\tau2] ↬ eˇ $$$$ ⇒ $$$$ ▶_{̸∀} [\tauˇ2] ⇒ ? $$MSTypeAp2$$ \Sigma; \Gamma ⊢ $$𝑀 $\check{e}$ \Rightarrow ˇ\tau$$ \Sigma ⊢ $$𝑀 \ta$\check{u}$2$$ \tauˇ ▶_{̸∀} $$$$ \Sigma; \Gamma ⊢ $$$$ ^{𝑀} eˇ $$$$ ⇒ $$$$ ▶_{̸∀} [\tauˇ2] ⇒ ? $$The case studies above demonstrate that the framework of the marked lambda calculus is suitable
to support a variety of extensions to richer judgmental structures. We hope that this spurs language
designers to design marked variants of other calculi, following the recipe we have demonstrated:
starting with a gradual, bidirectional type system, by considering each possible failure case, one may
systematically derive the necessary error marks and marking rules. The metatheorems, particularly
totality, ensure that no rules or premises have been missed.
We leave as future work the task of defining marked versions of even more elaborate bidirectional
type systems, e.g., Dunfield and Krishnaswami [2013]’s rather substantial formulation of implicit
type application in a bidirectional setting (which would have to handle, for example, the situation
where no implicit argument can be resolved) or Lennon-Bertrand [2022]’s gradual bidirectional
variant of the dependently typed calculus of constructions. Languages with operator overloading
may provide interesting localization decisions. So that overloading can be resolved during typing
and marking, the modes of one or both operand must be changed to synthesis. If the operator is
not defined given the synthesized operand type(s), an error might be marked on the operator itself.
Type classes [Wadler and Blott 1989] present a symmetric alternative where the operands may stay
in analytic mode. In either approach, the necessary error marks and localization decisions may be
arrived at via the recipe we have described. 3
INTEGRATING MARKING WITH EDITING$$ 3.1 $$Hazel Implementation We have implemented a marking system based on the marked lambda calculus as the foundation for
a new version of Hazel [Hazel Development Team 2023], a live functional programming environment
in which incomplete programs, i.e., programs that contain holes, may be type-checked, manipulated,$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 18 -->$$ 68:18 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar and even executed. In particular, we have implemented marking for all of the features in the previous$$ section as well as Hazel’s n-tuples, lists, algebraic datatypes, general pattern matching, strings, and $$$$ explicit polymorphism (all following the same recipe we developed above). Hazel is implemented in $$OCaml and compiles to Javascript via js_of_ocaml [Vouillon and Balat 2014] for use in the browser.
The supplemental material contains a pre-built implementation.
The result of this effort is the first full-scale typed functional language equipped with a language
server that solves the semantic gap problem: all of Hazel’s semantic services are available as long
as the program sketch is syntactically well-formed, which include type hints [Potter and Omar
2020], semantic navigation, semantic code completion [Blinn et al. 2022; Potter and Omar 2020],
contextualized documentation [Potter et al. 2022], and, because Hazel is able to evaluate programs
with empty and non-empty holes due to prior work [Omar et al. 2019], even semantic services that
require run-time information, like testing.
Hazel offers both a textual syntax, with explicit empty holes, and more interestingly, a structure
editor that is able to additionally offer partial syntactic error recovery. In particular, the tylr editor
uses a form of structured syntax error recovery that automatically insert empty holes to maintain
syntactic well-formedness as long as matching delimiters are placed by the user [Moon et al. 2022,
2023]. Efforts outside of the scope of this paper are underway to define syntactic error recovery
mechanisms that can handle unmatched delimiters as well, which would achieve total syntax error
recovery. In combination with our contributions, this would achieve the Hazel project’s stated goal
of ensuring that there are no meaningless editor states.$$ 3.2 $$Fixing Holes in Hazelnut Earlier versions of Hazel achieved total type error recovery by using a term-based structure editor,
which maintained delimiter matching by construction, albeit at the cost of some syntactic rigidity.
To specify such a structure editor formally, Omar et al. [2017a] introduced the Hazelnut action
calculus, which operates over a small bidirectionally typed lambda calculus extended with holes
and a cursor. The synthetic action judgment, written \Gamma \vdash e \Rightarrow \tau$$ -→^{𝛼 } e′ ⇒ \tau′, performs an edit action $$𝛼 on some zippered expression e (which is an expression with a superimposed cursor, denoted ˆe
in the original work) that synthesizes type \tau, producing some new e′ that synthesizes types \tau′.
Type and binding information is propagated to the location of the cursor during these operations,$$ allowing them to insert the necessary error marks (i.e. non-empty holes, in Hazelnut’s parlance). $$When, for example, wrapping an expression whose type is inconsistent with num in an arithmetic
operation, the calculus inserts an error mark around that operand: \tau ≁ num$$ \Gamma ⊢ ⊲e⊳ ⇒ \tau $$construct plusL$$ -----------→ eˇ≁ + ⊲⊳ ⇒ num $$However, a significant issue with Hazelnut is that it does not allow—and simply leaves undefined—
actions that require non-local mark insertions or removals. For example, although the system can
wrap an arbitrary expression e in an arithmetic operation, it cannot wrap it in a lambda abstraction,
i.e. construct \lambda x : ? . e directly from e. The binding of x with the unknown type may shadow a
previous binding and require the removal of error holes in the body. As a workaround, the calculus
includes manual mark insertion and removal actions.
The fundamental issue is that Hazelnut did not have a total marking system that it could deploy
to remark expressions where needed. The marked lambda calculus allows us to solve this problem,
in two different ways.
One approach is to define an untyped action calculus, wholly decoupling edit actions from typing.
Under this simplified design, the action calculus, given by a singular action judgment, written$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 19 -->
Total Type Error Localization and Recovery with Holes$$ 68:19 $$e -\to^{𝛼 } e′, is concerned only with the manipulation of syntax, and the total marking procedure
developed above yields statically meaningful terms with error marks inserted at the appropriate
positions as a kind of editor decoration. This solves the problem outlined above: since marking
operates on the entire program after each action, arbitrary constructions are permitted.
Alternatively, instead of a wholly untyped action calculus, one may directly integrate re-marking
logic into the typed Hazelnut calculus, making use of the type and scoping information being
propagated to re-mark only in positions where it might be necessary, in a roughly incremental
fashion. For example, we can wrap ˇe into \lambda x : ? . ˇe by re-marking the body under the context with
x binding the unknown type: ASEConLam$$ \Gamma, x : ? ⊢ ˇe^{□} ↬ ˇe′ ⇒ \tau′ $$$$ \Gamma ⊢ ⊲eˇ⊳ ⇒ \tau $$construct lam x$$ -----------→ \lambdax : ⊲ ? ⊳. ˇe′ ⇒ ? → \tau′ $$In this formulation, the action calculus is bidirectional and operates on zippered marked expressions,
written ˇe, where the cursor is superimposed atop marked expressions. With an analogous definition
of mark erasure on these expressions, the correctness of this typed action calculus may be defined
in relation to the behavior of the untyped variant.
The supplemental material contains a complete formal sketch of both variants, and the untyped
calculus and its related metatheory are mechanized in Agda. Because of the untyped variant’s
simplicity, and because marking is defined separately, this mechanization can serve universally
as a baseline for the correctness of approaches like the typed action calculus and perhaps other
analyses that minimize re-marking. We leave a complete assessment of this and other re-marking
optimization approaches to future work, particularly because Hazel is now moving toward the
decoupled approach for future development. 4
TYPE HOLE INFERENCE
Bidirectional typing, which has been our focus so far, reduces the number of necessary type
annotations and induces a local flow of information particularly well-suited to systematic error
localization decisions [Dunfield and Krishnaswami 2019; Pierce and Turner 2000]. In contrast,
constraint-based type inference as found in many ML-family languages allows programmers
to omit most or all type annotations [Pierce and Turner 2000]. The trade-off is that type error
localization and recovery become considerably more difficult, because inconsistencies can now
arise between constraints derived from many distant locations in a program. Heuristics aimed at
maximizing various optimization criteria are often employed to guess which uses of a variable are
consistent with the user’s intent and which should be marked erroneous [Pavlinovic et al. 2014;$$ Seidel et al. 2017; Zhang and Myers 2014]. $$This situation is reminiscent of the situation considered in Section 2.1.6 of inconsistent branches
in a conditional, where biasing one branch over the other requires guessing user intent, whereas the
neutral approach is to localize the inconsistency to the conditional expression as a whole. However,
there is no such parent expression in the case of inconsistent constraints gathered globally. This
search for neutrality when there are downstream conflicts motivates the approach we introduce in
this section, which gradually and neutrally harmonizes local and constraint-based type inference.
In particular, our type hole inference approach generates constraints on unknown types that arise
during the bidirectional marking process as described in Section 2. After this initial marking is
complete, we unify these constraints (using a standard unification algorithm, which we do not detail
here [Huet 1976]). When it is discovered that an unknown type is subject to inconsistent constraints,
we localize the problem to a hole in the program connected to that unknown type—either to a$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 20 -->$$ 68:20 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar type hole directly, or to an empty or non-empty expression hole from which that unknown type
traces its provenance. The key result is that this approach is neutral by construction: it does not
attempt to guess at which relevant locations were consistent with the user intent. In Hazel, the
user can instead interactively investigate various partially consistent suggestions to clarify their
intent, which returns control to the bidirectional type system.
The primary goal of type hole inference is not to act as a standalone typechecker, but to provide
comprehensive suggestions for filling type holes in marked expressions. This requires that the
unification procedure succeed regardless of type inconsistencies encountered in marked expressions.
However, once this requirement is accounted for, we may use standard unification algorithms by
treating our type holes as type variables [Huet 1976].$$ 4.1 $$Type Hole Inference in Hazel Unlike in ML-family languages where constraint solving is an obligate part of typing, in Hazel it is
optional (i.e., it can be turned off) and is only invoked for solving for unknown types. For example,
in the following Hazel program in Figure 8, no constraint solving is necessary: bidirectional typing
determines that f : Int and the error is localized to the application of f as a function, as described
in Section 2. This coincidentally is also how the corresponding OCaml program would localize
the error, but for different reasons: OCaml would detect inconsistent constraints and favor the
constraints arising lexically first [McAdam 1999; Odersky et al. 1999; Pottier 2014]. > [Non-text content omitted at bbox (54.4, 327.9, 231.9, 356.8)]
> [Non-text content omitted at bbox (251.6, 320.0, 429.1, 356.8)]
Fig. 8. Error localization of this program in Hazel and OCaml is similar, but for different reasons. The systems diverge in their capabilities if we explicitly add a type hole annotation to f. The
bidirectional system treats this as an unknown type and operates gradually, taking this as a signal
that the user has not yet determined the intended type of f. To help the user fill this type hole, the
system generates and attempts to unify the relevant constraints (see Section 4.3 below). In this case,
the constraints are inconsistent, i.e., there is no hole filling that satisfies all relevant constraints.
Rather than favoring constraints arising first, as in OCaml, the type hole itself is highlighted in
red and marked with a bang (!). The user is informed via the Type Inspector that the type hole
cannot be solved due to conflicting information from constraints. Figure 9 shows how the editor
temporarily fills the type hole when the user hovers over a constraint, deferring to bidirectional
error localization as described in Section 2 from there to cause the error to be marked on the 2
when hovering over the arrow type. > [Non-text content omitted at bbox (115.4, 528.2, 370.6, 551.2)]
> [Non-text content omitted at bbox (115.4, 552.2, 370.6, 565.6)]
> [Non-text content omitted at bbox (115.4, 566.6, 370.6, 589.7)]
> [Non-text content omitted at bbox (115.4, 590.7, 370.6, 611.7)]
Fig. 9. The error is localized to the conflicted type hole in Hazel. Placing the cursor (⟩) on the conflicted type
hole populates suggestions in the cursor inspector. When hovering over an indicated suggestion, the hole is
transiently filled, causing the error to be localized to the bound expression, 2.$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 21 -->
Total Type Error Localization and Recovery with Holes$$ 68:21 $$If, given this feedback, the user deletes the bound expression, 2, then there are no longer con-
flicting constraints on the type hole and the system displays the inferred type in gray, to indicate
that it has been inferred rather than entered as “ground truth” by the user. The user can press the
Enter key to accept the suggestion (turning the text purple). We depict this flow below in Fig. 10.
At this point the hole has been filled and localization decisions again become local. Note that there
are no constraints on the return type of f, so the suggested filling itself contains a type hole (see$$ Section 4.4 below on polymorphic generalization). $$> [Non-text content omitted at bbox (115.4, 179.2, 370.6, 202.1)]
> [Non-text content omitted at bbox (115.4, 203.1, 370.6, 216.3)]
> [Non-text content omitted at bbox (115.4, 217.3, 370.6, 240.3)]
Fig. 10. User removes ’2’ and accepts the new suggestion It is also worth considering the situation where no type annotation is present, but the bound
expression is an empty expression hole. As an example of this, consider Fig. 11. Here, the type of x
is unknown according to the bidirectional system from Section 2. Type hole inference solves for
this unknown type as well, while tracking its provenance as the type of this expression hole. As
such, errors due to conflicting constraints can be localized to expression holes in much the same
way as described above. When the user hovers over a suggested type, there must be some way of
constraining the type of the expression hole, e.g., by finding a suitable variable to annotate with a
type or by adding direct ascription syntax to the language (we have not implemented this particular
user interface affordance in Hazel as of yet, but there are no fundamental barriers to doing so.) The
lightly mocked up process of suggestion is also illustrated below in Fig. 11. > [Non-text content omitted at bbox (66.5, 405.0, 419.5, 459.8)]
Fig. 11. Localization of errors to expression holes.$$ 4.2 $$Constraint Generation and Unknown Type Provenance
In order to generate global inference results, we begin with constraint generation. Our approach$$ closely follows the usual approach (cf. [Pierce 2002]), where we augment the bidirectional type $$system for the marked lambda calculus with generated constraint sets, 𝐶. The new judgement$$ forms are \Gamma ⊢ ˇe ⇒ \tau | 𝐶 and \Gamma ⊢ ˇe ⇐ \tau | 𝐶 . $$Constraints, written \tau1 \approx \tau2, force two incomplete types to be consistent. Consequently, our rules
for constraint generation are quite simple. We augment our previous bidirectional typing rules in
the marked lambda calculus to accumulate constraints describing necessary type consistencies. For
example, when synthesizing the type of an if expression, we constrain the types of expressions in
either branch to each other:$$ MSIf-C $$$$ \Gamma ⊢ ˇe1 ⇐ bool | 𝐶1 $$$$ \Gamma ⊢ ˇe2 ⇒ \tau1 | 𝐶2 $$$$ \Gamma ⊢ ˇe3 ⇒ \tau2 | 𝐶3 $$\tau3 = \tau1 \sqcap \tau2$$ \Gamma ⊢ if ˇe1 then ˇe2 else ˇe3 ⇒ \tau3 | 𝐶1 ∪ 𝐶2 ∪ 𝐶3 ∪ {\tau1 ≈ \tau2} $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 22 -->$$ 68:22 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar The remaining rules for standard constructs are similarly standard and given in the supplement.
Since unification will be solving for unknown types, we must ensure we are able to distinguish
between different type holes based on their associated locus in the program. To this end, we make
two modifications to the system from Section 2: (1) We add a unique idu to all expression holes and type holes that appear directly in the program
where we assume that id generation is handled by the editor. (2) We add provenances 𝑝 to unknown types. Each provenance links the unknown type to
some (syntactic) hole in the program, perhaps through some intermediate operations. For
example, the provenance ex𝑝(3) indicates that a type hole must have been synthesized from
an expression hole with id 3 in the program. Provenance
𝑝$$ u | ex𝑝(u) |→𝐿 (𝑝) |→𝑅 (𝑝) | ×𝐿(𝑝) | ×𝑅(𝑝) $$Type
\tau$$ · · · | ?^{𝑝} $$MExp
$\check{e}$$$ · · · | x^{u} $$$$ □ | eˇ^{u} $$$$ ^{≁} | · · · | eˇ $$$$ _{⇒}, u $$$$ ▶\not\times $$$$ | eˇ $$$$ _{⇒}, u $$$$ ▶\not\times $$$$ | ^{u} $$Provenance is determined whenever a new unknown type is constructed. For example, we update
our matched arrow and product rules to add provenances to outputted type holes and introduce the
new matched arrow and product provenances so that every time a matched arrow type is generated
for the same hole, it involves the same constituent unknown types without necessitating fresh id
generation.$$ TMAHole-C $$$$ ?𝑝 ▶→ ?→^{𝐿} (𝑝) → ?→^{𝑅} (𝑝) | {?𝑝 ≈ ?→^{𝐿} (𝑝) → ?→^{𝑅} (𝑝) } $$$$ TMPHole-C $$$$ ?𝑝 ▶× ?×^{𝐿} (𝑝) × ?×^{𝑅} (𝑝) | {?𝑝 ≈ ?×^{𝐿} (𝑝) × ?×^{𝑅} (𝑝) } $$Up until now, we have ignored rules that consider marked errors. This leads us to our second
point of interest: what do we do with expressions that have been marked with expression holes? A
marked expression has already been deemed erroneous. Therefore, when generating constraints,
we do not constrain sub-expressions within a marked hole based on types flowing in from outside
the hole. As a simple example of this, we present the standard rule for successful subsumption
alongside the rule for subsumption upon the failure of the consistency check: MASubsume-C$$ \Gamma ⊢ ˇe ⇒ \tau′ | 𝐶 $$\tau ∼ \tau′
$\check{e}$ subsumable$$ \Gamma ⊢ ˇe ⇐ \tau | 𝐶 ∪ {\tau ≈ \tau′} $$MAInconsistentTypes-C$$ \Gamma ⊢ ˇe ⇒ \tau′ | 𝐶 $$\tau ≁ \tau′
$\check{e}$ subsumable$$ \Gamma ⊢ eˇ^{u} $$$$ ≁ ⇐ \tau | 𝐶 ∪ {\tau ≈ ?^{ex𝑝} (^{u})} $$The remaining rules directly follow the intuitions above and are left to the supplemental material.$$ 4.3 $$Unification and Potential Type Sets
To unify constraints, we use a standard union-find based unification algorithm [Huet 1976; Siek
and Vachharajani 2008], which accumulates constraint information in PotentialTypeSets.
A PotentialTypeSet is a recursive data structure representing all of the potential fillings for an
associated incomplete type, inferred from type constraints. To facilitate this, rather than substi-
tuting types during unification, which results in a loss of information, we continuously merge
PotentialTypeSets. Since unification treats relations transitively, a property consistency lacks across
complete types, we avoid generating PotentialTypeSets for complete types and simply extend$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 23 -->
Total Type Error Localization and Recovery with Holes$$ 68:23 $$existing PotentialTypeSets with them as needed. PotentialTypeSet 𝑠$$ single(𝑡) | cons(𝑡,𝑠) $$PotentialType 𝑡$$ num | bool | ?^{𝑝} | 𝑠 → 𝑠 | 𝑠 × 𝑠 $$These choices allows us to continue past failures and unify any constraints, yielding an accumulated
corpus of information on each type hole’s potential solutions and errors through their associated Po-
tentialTypeSets. Each PotentialTypeSet can be scanned by the editor to identify potential solutions$$ or localize errors as illustrated in Fig. 9 and Fig. 10. $$Note again that the novel contribution of this section is not in the particular unification algorithm
but rather the architectural decisions that allow us to neatly blend local and constraint-based type
inference systems for orthogonal purposes within the same system, and our focus on how to handle
inconsistent constraints. As such, we direct the reader to prior work for the algorithmic, formal,
and metatheoretic details of unification [Siek and Vachharajani 2008].$$ 4.4 $$Polymorphic Generalization with Holes In many type inference systems, unconstrained type inference variables (here, unknown types) are
automatically polymorphically generalized, so that functions can be given the most general type
[Garcia and Cimini 2015]. The same approach can be taken with type hole inference, but with one
particularly interesting wrinkle. With the inclusion of expression holes in our system, we need to
be a bit more careful about when we generalize. Consider the following expression:$$ \lambdax : ?^{1} . ^{2} $$We can see that ?^{1} is not constrained. Suppose that we were to suggest the implicitly universally$$ quantified type variable_{ }′a as a type hole filling for ?^{1}. It is unlikely that the user accepts this $$suggestion because it is unlikely that the user intends to write the identity function! The fact there
are not yet any constraints does not imply that there will not be once the expression hole is filled.
To address this, we need to reason as if there are any number of unknown constraints coming
from expression holes. This can be represented with a new type of constraint: the etc constraint,
which we add to our syntax of PotentialTypes below. PotentialType 𝑡$$ · · · | etc $$When an expression hole appears, all unknown types in the typing context are constrained to
etc. This has no impact on unification, but if a type hole ?^{𝑝} is constrained to etc, it cannot be
generalized. As before, more expansive discussion on unification with gradual typing including
polymorphism is left to prior work [Garcia and Cimini 2015]. 5
RELATED WORK
The contributions of this paper build directly on the Hazelnut type system [Omar et al. 2017a],
which is discussed extensively throughout. Non-empty holes in Hazelnut generalize to marks in
this work. In brief, we contribute a total marking procedure (Section 2) and type hole inference
scheme (Section 4) for a system based closely on Hazelnut, and use it to fix some expressiveness
issues in Hazelnut’s edit action calculus (Section 3).
Hazelnut is in-turn rooted in gradual type theory [Siek and Taha 2006; Siek et al. 2015]. We make
extensive use of (only) the static aspects of gradual typing—namely, the universal consistency of the
unknown type—to enable recovery from marked errors, which can leave missing type information.
Our focus was exclusively on static typing in this paper, and the results are relevant to the design
of language servers for any statically typed language, but it is worth noting that the results in
this paper, taken together with Hazel’s support for maintaining syntactic well-formedness using
structure editing [Moon et al. 2022, 2023] and for running programs with holes and marked errors$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 24 -->$$ 68:24 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar [Omar et al. 2019], allow our implementation of Hazel to achieve total liveness: every editor state is$$ syntactically, statically, and dynamically meaningful, without gaps. $$Type error localization is a well-studied problem in practice. This paper is the first to formally
support the intuition that, in the words of Dunfield and Krishnaswami [2019], “bidirectional typing
improves error locality.” Although there has been considerable folklore around error localization
for systems with local type inference, the problem has received little formal attention. We hope that
this paper, with its rigorous formulation of type error localization and recovery for bidirectionally
typed languages, will provide more rigorous grounding to language server development, much as
bidirectional typing has done for type checker development.
For systems rooted in constraint solving, there has been considerable work in improving error
localization because such systems are notorious for making error localization difficult, and pro-
grammers are often confused by localization decisions [Wand 1986] because they are rooted in ad
hoc traversal orders [Lee and Yi 1998; McAdam 1999]. More recently, there has been a series of
papers that discuss finding the most likely location for an error based on a maximum likelihood
criterion applied to type flows [Zhang and Myers 2014] or manual/learned weights [Pavlinovic et al.
2014; Seidel et al. 2017]. While improving the situation somewhat, these remain fundamentally ad
hoc in their need to guess the user’s likely intent. However, these approaches could perhaps be
layered atop type hole inference to improve the ranking or filtering of suggestions.
A more neutral alternative is to derive a set of terms that contribute to an error, an approach
known as type error slicing [Haack and Wells 2003; Schilling 2011; Tip and Dinesh 2001]. This
creates a large amount of information for the programmer to consume. Our approach is to instead
simply report the constraint inconsistencies on a hole in the program and allow for the programmer
to interactively refine their intent, so only the bidirectional type system is responsible for identifying
particular erroneous expressions. We do not make particular usability claims about the interactive
affordances related to type hole inference in this paper, but rather simply claim a novel neutral
point in the overall design space that uniquely combines local and global approaches.
Recent work on gradual liquid type inference described an exploratory interface for filling holes
in refinement types by selecting from partial solutions to conflicting refinement type constraints
[Vazou et al. 2018]. This is similar in spirit to type hole inference as described in this paper, albeit
targeting program verification predicates.
The underlying unification algorithm is essentially standard—the novelty is in how the unification
results are used and how failures are handled, rather than in the inference itself. In particular,
we base our approach on the system described by Siek and Vachharajani [2008], because it also
identifies type inference variables with the unknown type from gradual typing and the union find
data structure is useful for computing possible type sets. Garcia and Cimini [2015] similarly present
a static implicitly typed language, where users opt into dynamism by annotating an expression with
the gradual type "?", and an associated type inference algorithm and accompanying metatheory. By
contrast, the Hazelnut type system assigns gradual types to programs that would ordinarily not
type-check in a non-gradual system by wrapping them in expression holes. The type inference
algorithm presented in Garcia and Cimini [2015] also does not specify what to do if the constraint
set cannot be solved. If a single static type cannot be determined for an expression, its type is
simply undefined, whereas our approach provides a list of suggestions derived from any conflicting
constraints if a single substitution cannot be determined. As our focus is on failure cases and
partially consistent suggestions, the metatheory in this prior work is less relevant in guiding the
design of the type hole inference system.
Of note, however, is that approaches that eagerly solve and substitute for type inference variables
[McAdam 1999; Odersky et al. 1999; Pottier 2014] are not well-suited to the type hole inference
approach, as they lose information necessary for computing partially consistent suggestions.$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 25 -->
Total Type Error Localization and Recovery with Holes$$ 68:25 $$In the realm of error messages for constraint-based inference, work on the Helium Haskell
compiler [Heeren et al. 2003] offers two constraint solvers based on the desired feedback: a global,
type graph-based constraint solver which provides detailed error messages, and a lightweight and
high-performance greedy solver. When using the global constraint solver, various heuristics can
tune the likelihood of different parts of programs reported as error sources. Recently, Bhanuka et al.
[2023] model the flow of type information throughout the program using subtyping constraints to
produce detailed error messages when unification fails. Seidel et al. [2016] provide sample inputs
(dynamic witnesses) that elicit runtime errors. With this approach, one can generate graphs for
visualizing the execution of witnesses and heuristically identify the source of errors with around
70% accuracy. Our focus in this paper has not been on the error messages displayed on-screen,
about which we make no specific claims. It may, however, be beneficial in future work to indicate to
the user from where in the program type suggestions originated via our type provenances and by
incorporating the techniques in this prior work, e.g. to explain why a particular suggestion arises. 6
CONCLUSION Nothing will ever be attempted if all possible objections must first be overcome. - Samuel Johnson Programming is increasingly a live collaboration between human programmers and sophisticated
semantic services. These services need to be able to reason throughout the programming process,
not just when the program is formally complete. This paper lays down rigorous type-theoretic
foundations for doing just that. Bidirectional type checking helps make the localization decisions
we make systematic and predictable, and type hole inference shows how local and constraint-based
type inference might operate hand-in-hand, rather than as alternatives. Throughout, we focused on
maintaining neutrality about user intent whenever possible. We hope that language designers will
use the techniques introduced in this paper to consider more rigorously, perhaps even formally,
the problems of type error localization and error recovery when designing future languages. DATA AVAILABILITY STATEMENT
An artifact [Zhao et al. 2023] containing the complete formalization of the marked lambda cal-
culus and the extensions described above, the Agda mechanization, and the implementation of
Hazel including type hole inference is available. Up-to-date versions of the formalism and mecha-$$ nization may be found at https://github.com/hazelgrove/error-localization-agda. Hazel is being $$actively developed—more information is available at https://hazel.org, and the Hazel source code is$$ maintained at https://github.com/hazelgrove/hazel. $$ACKNOWLEDGEMENTS
The authors would like to thank the anonymous referees at POPL 2024 and ICFP 2023 for helpful
feedback on earlier drafts of this paper. This work was partially funded through the NSF grant$$ #CCF-2238744. $$ERRATA
A previous version of this paper published by the ACM had an error in the third premise of the
MALam3 rule in which the context was extended as \Gamma, x : \tau1 instead of \Gamma, x : \tau. REFERENCES Djonathan Barros, Sven Peldszus, Wesley K. G. Assunç ao, and Thorsten Berger. 2022. Editing support for software languages:
implementation practices in language server protocols. In Proceedings of the 25th International Conference on Model$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 26 -->$$ 68:26 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar Driven Engineering Languages and Systems, MODELS 2022, Montreal, Quebec, Canada, October 23-28, 2022, Eugene Syriani,$$ Houari A. Sahraoui, Nelly Bencomo, and Manuel Wimmer (Eds.). ACM, 232-243. https://doi.org/10.1145/3550355.3552452 $$Ishan Bhanuka, Lionel Parreaux, David Binder, and Jonathan Immanuel Brachthäuser. 2023. Getting into the flow: Towards
better type error messages for constraint-based type inference. Proceedings of the ACM on Programming Languages 7,$$ OOPSLA2 (2023), 431-459. https://doi.org/10.1145/3622812 $$Andrew Blinn, David Moon, Eric Griffis, and Cyrus Omar. 2022. An Integrative Human-Centered Architecture for Interactive
Programming Assistants. In 2022 IEEE Symposium on Visual Languages and Human-Centric Computing (VL/HCC). 1-5.$$ https://doi.org/10.1109/VL/HCC53370.2022.9833110 $$Frédéric Bour, Thomas Refis, and Gabriel Scherer. 2018. Merlin: a language server for OCaml (experience report). Proc. ACM$$ Program. Lang. 2, ICFP (2018), 103:1-103:15. https://doi.org/10.1145/3236798 $$Edwin C. Brady. 2013. Idris, a general-purpose dependently typed programming language: Design and implementation. J.$$ Funct. Program. 23, 5 (2013), 552-593. https://doi.org/10.1017/S095679681300018X $$Yair Chuchem and Eyal Lotem. 2019. Steady Typing.
Matteo Cimini and Jeremy G. Siek. 2016. The gradualizer: a methodology and algorithm for generating gradual type
systems. In Proceedings of the 43rd Annual ACM SIGPLAN-SIGACT Symposium on Principles of Programming Languages,$$ POPL 2016, St. Petersburg, FL, USA, January 20 - 22, 2016, Rupak Majumdar Rastislav Bodík (Ed.). ACM, 443-455. $$$$ https://doi.org/10.1145/2837614.2837632 $$Evan Czaplicki and Stephen Chong. 2013. Asynchronous functional reactive programming for GUIs. In ACM SIGPLAN
Conference on Programming Language Design and Implementation, PLDI ’13, Seattle, WA, USA, June 16-19, 2013, Hans-$$ Juergen Boehm and Cormac Flanagan (Eds.). ACM, 411-422. https://doi.org/10.1145/2491956.2462161 $$Sérgio Queiroz de Medeiros, Gilney de Azevedo Alvez Junior, and Fabio Mascarenhas. 2020. Automatic syntax error reporting$$ and recovery in parsing expression grammars. Sci. Comput. Program. 187 (2020), 102373. https://doi.org/10.1016/J.SCICO. $$2019.102373$$ Jana Dunfield and Neel Krishnaswami. 2019. Bidirectional Typing. CoRR abs/1908.05839 (2019). arXiv:1908.05839 http: $$$$ //arxiv.org/abs/1908.05839 $$Jana Dunfield and Neelakantan R. Krishnaswami. 2013. Complete and easy bidirectional typechecking for higher-rank
polymorphism. In ACM SIGPLAN International Conference on Functional Programming, ICFP’13, Boston, MA, USA -$$ September 25 - 27, 2013, Greg Morrisett and Tarmo Uustalu (Eds.). ACM, 429-442. https://doi.org/10.1145/2500365.2500582 $$Ronald Garcia and Matteo Cimini. 2015. Principal Type Schemes for Gradual Programs. In Proceedings of the 42nd Annual
ACM SIGPLAN-SIGACT Symposium on Principles of Programming Languages, POPL 2015, Mumbai, India, January 15-17,$$ 2015, Sriram K. Rajamani and David Walker (Eds.). ACM, 303-315. https://doi.org/10.1145/2676726.2676992 $$Christian Haack and Joe B. Wells. 2003. Type Error Slicing in Implicitly Typed Higher-Order Languages. In Programming
Languages and Systems, 12th European Symposium on Programming, ESOP 2003, Held as Part of the Joint European
Conferences on Theory and Practice of Software, ETAPS 2003, Warsaw, Poland, April 7-11, 2003, Proceedings (Lecture Notes in$$ Computer Science, Vol. 2618), Pierpaolo Degano (Ed.). Springer, 284-301. https://doi.org/10.1007/3-540-36575-3_20 $$$$ HaskellWiki. 2014. GHC/Typed holes — HaskellWiki. https://wiki.haskell.org/index.php?title=GHC/Typed_holes&oldid= $$$$ 58717 [Online; accessed 2-March-2023]. $$$$ Hazel Development Team. 2023. Hazel. http://hazel.org/. http://hazel.org/ $$Bastiaan Heeren, Daan Leijen, and Arjan van IJzendoorn. 2003. Helium, for learning Haskell. In Proceedings of the ACM$$ SIGPLAN Workshop on Haskell, Haskell 2003, Uppsala, Sweden , August 28, 2003, Johan Jeuring (Ed.). ACM, 62-71. $$$$ https://doi.org/10.1145/871895.871902 $$$$ Gérard P. Huet. 1976. Resolution d’Equations dans les langages d’ordre 1, 2, ..., omega. Ph. D. Dissertation. Université de Paris $$$$ VII. $$Stef Joosten, Klaas van den Berg, and Gerrit van Der Hoeven. 1993. Teaching Functional Programming to First-Year Students.$$ J. Funct. Program. 3, 1 (1993), 49-65. https://doi.org/10.1017/S0956796800000599 $$Oukseh Lee and Kwangkeun Yi. 1998. Proofs about a Folklore Let-Polymorphic Type Inference Algorithm. ACM Trans.$$ Program. Lang. Syst. 20, 4 (1998), 707-723. https://doi.org/10.1145/291891.291892 $$Meven Lennon-Bertrand. 2022. Bidirectional Typing for the Calculus of Inductive Constructions. (Typage Bidirectionnel pour le$$ Calcul des Constructions Inductives). Ph. D. Dissertation. University of Nantes, France. https://tel.archives-ouvertes.fr/tel- $$03848595 Bruce J. McAdam. 1999. On the Unification of Substitutions in Type Inference. In Implementation of Functional Languages,$$ Kevin Hammond, Tony Davie, and Chris Clack (Eds.). Springer Berlin Heidelberg, Berlin, Heidelberg, 137-152. $$David Moon, Andrew Blinn, and Cyrus Omar. 2022. tylr: a tiny tile-based structure editor. In TyDe ’22: 7th ACM SIGPLAN$$ International Workshop on Type-Driven Development, Ljubljana, Slovenia, 11 September 2022. ACM, 28-37. https://doi.org/ $$$$ 10.1145/3546196.3550164 $$David Moon, Andrew Blinn, and Cyrus Omar. 2023. Gradual Structure Editing with Obligations. In 2023 IEEE Symposium on$$ Visual Languages and Human-Centric Computing (VL/HCC). 71-81. https://doi.org/10.1109/VL-HCC57772.2023.00016 $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 27 -->
Total Type Error Localization and Recovery with Holes$$ 68:27 $$Ulf Norell. 2007. Towards a practical programming language based on dependent type theory. Ph. D. Dissertation. Department
of Computer Science and Engineering, Chalmers University of Technology, SE-412 96 Göteborg, Sweden. Martin Odersky, Martin Sulzmann, and Martin Wehr. 1999. Type Inference with Constrained Types. Theory Pract. Object$$ Syst. 5, 1 (1999), 35-55. $$Cyrus Omar, Ian Voysey, Ravi Chugh, and Matthew A. Hammer. 2019. Live functional programming with typed holes. Proc.$$ ACM Program. Lang. 3, POPL (2019), 14:1-14:32. https://doi.org/10.1145/3290327 $$$$ Cyrus Omar, Ian Voysey, Michael Hilton, Jonathan Aldrich, and Matthew A. Hammer. 2017a. Hazelnut: a bidirectionally $$typed structure editor calculus. In Proceedings of the 44th ACM SIGPLAN Symposium on Principles of Programming$$ Languages, POPL 2017, Paris, France, January 18-20, 2017, Giuseppe Castagna and Andrew D. Gordon (Eds.). ACM, 86-99. $$$$ https://doi.org/10.1145/3009837.3009900 $$Cyrus Omar, Ian Voysey, Michael Hilton, Joshua Sunshine, Claire Le Goues, Jonathan Aldrich, and Matthew A. Hammer.
2017b. Toward Semantic Foundations for Program Editors. In 2nd Summit on Advances in Programming Languages, SNAPL$$ 2017, May 7-10, 2017, Asilomar, CA, USA (LIPIcs, Vol. 71), Benjamin S. Lerner and Shriram Krishnamurthi Rastislav Bodík $$$$ (Eds.). Schloss Dagstuhl - Leibniz-Zentrum für Informatik, 11:1-11:12. https://doi.org/10.4230/LIPICS.SNAPL.2017.11 $$Zvonimir Pavlinovic, Tim King, and Thomas Wies. 2014. Finding minimum type error sources. In Proceedings of the 2014
ACM International Conference on Object Oriented Programming Systems Languages & Applications, OOPSLA 2014, part$$ of SPLASH 2014, Portland, OR, USA, October 20-24, 2014, Andrew P. Black and Todd D. Millstein (Eds.). ACM, 525-542. $$$$ https://doi.org/10.1145/2660193.2660230 $$Benjamin C. Pierce. 2002. Types and programming languages. MIT Press.$$ Benjamin C. Pierce and David N. Turner. 2000. Local type inference. ACM Trans. Program. Lang. Syst. 22, 1 (2000), 1-44. $$$$ https://doi.org/10.1145/345099.345100 $$Hannah Potter, Ardi Madadi, René Just, and Cyrus Omar. 2022. Contextualized Programming Language Documentation.
In Proceedings of the 2022 ACM SIGPLAN International Symposium on New Ideas, New Paradigms, and Reflections on
Programming and Software, Onward! 2022, Auckland, New Zealand, December 8-10, 2022, Christophe Scholliers and Jeremy$$ Singer (Eds.). ACM, 1-15. https://doi.org/10.1145/3563835.3567654 $$Hannah Potter and Cyrus Omar. 2020. Hazel Tutor: Guiding Novices Through Type-Driven Development Strategies. Human
Aspects of Types and Reasoning Assistants (HATRA) (2020). François Pottier. 2014. Hindley-milner elaboration in applicative style: functional pearl. In Proceedings of the 19th ACM
SIGPLAN international conference on Functional programming, Gothenburg, Sweden, September 1-3, 2014, Johan Jeuring$$ and Manuel M. T. Chakravarty (Eds.). ACM, 203-212. https://doi.org/10.1145/2628136.2628145 $$Thomas Schilling. 2011. Constraint-Free Type Error Slicing. In Trends in Functional Programming, 12th International
Symposium, TFP 2011, Madrid, Spain, May 16-18, 2011, Revised Selected Papers (Lecture Notes in Computer Science, Vol. 7193),$$ Ricardo Peña and Rex L. Page (Eds.). Springer, 1-16. https://doi.org/10.1007/978-3-642-32037-8_1 $$Eric L. Seidel, Ranjit Jhala, and Westley Weimer. 2016. Dynamic witnesses for static type errors (or, ill-typed programs
usually go wrong). In Proceedings of the 21st ACM SIGPLAN International Conference on Functional Programming, ICFP$$ 2016, Nara, Japan, September 18-22, 2016, Jacques Garrigue, Gabriele Keller, and Eijiro Sumii (Eds.). ACM, 228-242. $$$$ https://doi.org/10.1145/2951913.2951915 $$$$ Eric L. Seidel, Huma Sibghat, Kamalika Chaudhuri, Westley Weimer, and Ranjit Jhala. 2017. Learning to blame: localizing $$$$ novice type errors with data-driven diagnosis. Proc. ACM Program. Lang. 1, OOPSLA (2017), 60:1-60:27. $$$$ https: $$$$ //doi.org/10.1145/3138818 $$Jeremy G. Siek and Walid Taha. 2006. Gradual Typing for Functional Languages. In Scheme and Functional Programming
Workshop. Jeremy G. Siek and Manish Vachharajani. 2008. Gradual typing with unification-based inference. In Proceedings of the$$ 2008 Symposium on Dynamic Languages, DLS 2008, July 8, 2008, Paphos, Cyprus, Johan Brichau (Ed.). ACM, 7. https: $$$$ //doi.org/10.1145/1408681.1408688 $$Jeremy G. Siek, Michael M. Vitousek, Matteo Cimini, and John Tang Boyland. 2015. Refined Criteria for Gradual Typing. In$$ 1st Summit on Advances in Programming Languages, SNAPL 2015, May 3-6, 2015, Asilomar, California, USA (LIPIcs, Vol. 32), $$$$ Thomas Ball, Rastislav Bodik, Shriram Krishnamurthi, Benjamin S. Lerner, and Greg Morrisett (Eds.). Schloss Dagstuhl - $$$$ Leibniz-Zentrum für Informatik, 274-293. https://doi.org/10.4230/LIPICS.SNAPL.2015.274 $$$$ Armando Solar-Lezama. 2013. Program sketching. Int. J. Softw. Tools Technol. Transf. 15, 5-6 (2013), 475-495. $$$$ https: $$$$ //doi.org/10.1007/S10009-012-0249-7 $$Arthur Sorkin and Peter Donovan. 2011. LR(1) parser generation system: LR(1) error recovery, oracles, and generic tokens.$$ ACM SIGSOFT Softw. Eng. Notes 36, 2 (2011), 1-5. https://doi.org/10.1145/1943371.1943391 $$Tim Teitelbaum and Thomas W. Reps. 1981. The Cornell Program Synthesizer: A Syntax-Directed Programming Environment.$$ Commun. ACM 24, 9 (1981), 563-573. https://doi.org/10.1145/358746.358755 $$Frank Tip and T. B. Dinesh. 2001. A slicing-based approach for locating type errors. ACM Trans. Softw. Eng. Methodol. 10, 1$$ (2001), 5-55. https://doi.org/10.1145/366378.366379 $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$--- <!-- Page 28 -->$$ 68:28 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar Niki Vazou, Éric Tanter, and David Van Horn. 2018. Gradual liquid type inference. Proc. ACM Program. Lang. 2, OOPSLA$$ (2018), 132:1-132:25. https://doi.org/10.1145/3276502 $$$$ Jérôme Vouillon and Vincent Balat. 2014. From bytecode to JavaScript: the Js_of_ocaml compiler. Softw. Pract. Exp. 44, 8 $$$$ (2014), 951-972. https://doi.org/10.1002/SPE.2187 $$Philip Wadler and Stephen Blott. 1989. How to Make ad-hoc Polymorphism Less ad-hoc. In Conference Record of the Sixteenth
Annual ACM Symposium on Principles of Programming Languages, Austin, Texas, USA, January 11-13, 1989. ACM Press,$$ 60-76. https://doi.org/10.1145/75277.75283 $$Mitchell Wand. 1986. Finding the Source of Type Errors. In Conference Record of the Thirteenth Annual ACM Symposium
on Principles of Programming Languages, St. Petersburg Beach, Florida, USA, January 1986. ACM Press, 38-43. https:$$ //doi.org/10.1145/512644.512648 $$Yongwei Yuan, Scott Guest, Eric Griffis, Hannah Potter, David Moon, and Cyrus Omar. 2023. Live Pattern Matching with$$ Typed Holes. Proc. ACM Program. Lang. 7, OOPSLA1 (2023), 609-635. https://doi.org/10.1145/3586048 $$Danfeng Zhang and Andrew C. Myers. 2014. Toward general diagnosis of static errors. In The 41st Annual ACM SIGPLAN-
SIGACT Symposium on Principles of Programming Languages, POPL ’14, San Diego, CA, USA, January 20-21, 2014, Suresh$$ Jagannathan and Peter Sewell (Eds.). ACM, 569-582. https://doi.org/10.1145/2535838.2535870 $$Eric Zhao, Raef Maroof, Anand Dukkipati, Andrew Blinn, Zhiyi Pan, and Cyrus Omar. 2023. Artifact for Total Type Error$$ Localization and Recovery with Holes. https://doi.org/10.5281/zenodo.10129703 $$$$ Received 2023-07-11; accepted 2023-11-07 $$$$ Proc. ACM Program. Lang., Vol. 8, No. POPL, Article 68. Publication date: January 2024. $$