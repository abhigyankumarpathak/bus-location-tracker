{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.typescript-language-server
    # `npx serve` is used by the deployment build to serve the static export.
    pkgs.nodePackages.serve
  ];
}
