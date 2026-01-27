
Or-Patterns

V. E. McHale

18 Oct. 2025

Begin by defining Ord:

type Ord = {`lt ⊕ `eq ⊕ `gt};

Then we can write:

gt : Ord -- Bool
    := [ { { `lt⁻¹ & `eq⁻¹ } False & `gt⁻¹ True } ]

{`lt⁻¹ & `eq⁻¹} has type {`lt ⊕ `eq} --. The use of & to juxtapose pattern match arms is intended to recall

from linear logic (Munch-Maccagnoni 2009).

This makes sense—a & (“with”) juxtaposes two pattern-match arms (inverse constructors) to form a (typed) function accepting a sum type as argument.

lte : { `lt ⊕ `eq } --
    := [ { `lt⁻¹ & `eq⁻¹ } ]

gte : { `eq ⊕ `gt } --
    := [ { `eq⁻¹ & `gt⁻¹ } ]

We could have defined gt with the above, viz.

gt : Ord -- Bool
   := [ { lte False & `gt⁻¹ True } ]

Munch-Maccagnoni, Guillaume. 2009. “Focalisation and Classical Realisability.” In Computer Science Logic, edited by Erich Grädel and Reinhard Kahle. Springer Berlin Heidelberg.
