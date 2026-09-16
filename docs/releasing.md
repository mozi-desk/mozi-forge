# Release preparation

1. Start from a clean, reviewed revision and run the documented validation suite.
2. Run `pnpm check:pack` and inspect each tarball, exports, bundled notices and license.
3. Verify the tarballs install together in a clean project without local source paths.
4. Verify public content contains only project information and generic examples.
5. Confirm package versions, registry ownership and dependency licensing.
6. Publish only with explicit maintainer authorization and record the published versions.

The workspace root is private. Library packages declare Apache-2.0, public access,
and explicit package contents. Package manifests alone do not indicate publication.
