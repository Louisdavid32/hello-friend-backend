# Plateforme `documentation`

Mission : produire des contrats consultables et verifier que les API publiques du code ne deviennent
pas orphelines.

- OpenAPI/Swagger documente HTTP et RFC 9457 en developpement/test ;
- TypeDoc genere la reference depuis TSDoc ;
- les README de modules decrivent comportement et invariants ;
- `04-specification-fonctionnelle-modulaire.md` maintient les parcours globaux ;
- les schemas realtime versionnes constituent le futur contrat WSS.

Swagger est desactive par defaut hors local pour limiter la surface. Une route nouvelle exige DTO,
succes, erreurs et test du document genere. Un symbole public nouveau exige TSDoc valide. Les
commentaires expliquent les contrats et decisions non evidentes, pas chaque affectation triviale.

References : [NestJS OpenAPI](https://docs.nestjs.com/openapi/introduction),
[TypeDoc validation](https://typedoc.org/documents/Options.Validation.html).
