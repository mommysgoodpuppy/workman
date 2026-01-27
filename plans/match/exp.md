
Solving the Expression Problem

V. E. McHale

14 Nov. 2025

Suppose we have

type Either a b = { a `left ⊕ b `right };

mapLeft : [ a -- c ] Either(a,b) -- Either(c,b)
        := [ { `left⁻¹ swap $ `left
             & `right⁻¹ nip `right
             }

Then we can define

type Both a b = Either(a,b) ∪ { a b `both };

We can extend mapLeft, viz.

mapL : [a -- b] Both(a,c) -- Both(b,c)
     := [ { mapLeft
          & `both⁻¹ [swap $] dip `both
          }
        ]

mapL accepts a value of type Either(a,b) as argument:

x : -- Either(Bool,Int)
  := [ True `left ]

b : -- Both(Bool,Int)
  := [ [ not ] x mapL ]

Functions defined for Either(a,b) do not need to be rewritten and they do not compromise safety.

c : Both(Bool, Int) -- Either(Bool,Int)
  := [ [ not ] swap mapLeft ]

{Bool `left ⊕ Int `right ⊕ Bool Int `both} ⊀ {Bool `left ⊕ Int `right}

Pattern matching is different from a function returning values: it is a disjunctive product. By accounting for polarity, i.e. argument vs. return value, we get extensible pattern matching. Both the “left” and “right” aspects are first-class.

To wit, we can define

left : { a `left ⊕ a b `both } -- a
     := [ { `left⁻¹ & `both⁻¹ drop } ]

which can be thought of as an or-pattern binding a variable.

As Wadler (1998) puts it,

    One can think of cases as rows and functions as columns in a table. In a functional language, the rows are fixed (cases in a datatype declaration) but it is easy to add new columns (functions). In an object-oriented language, the columns are fixed (methods in a class declaration) but it is easy to add new rows (subclasses). We want to make it easy to add either rows or columns.

Polarity, wherein argument and return value are dual (De Morgan laws for disjunctive product (pattern match, argument) and disjunctive sum (return value)) frames the expression problem.
Reference
Wadler, Philip. 1998. The Expression Problem. Https://homepages.inf.ed.ac.uk/wadler/papers/expression/expression.txt.
