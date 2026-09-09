# Third-party notices for omo-webchat

The root LICENSE applies to original omo-webchat code and documentation, not to
third-party components or artwork. Their copyrights, license conditions, patent
terms, and disclaimers remain in force. This notice is not a grant of trademark
rights or an endorsement by any upstream author.

This packet covers the native Go application, the embedded React application,
and its bundled fonts and icons. Versions below are taken from go.mod and
frontend/package-lock.json or explicitly identified upstream source revisions.
Full license texts follow the inventories. A dependency's license is not inferred
from omo-webchat's MIT license. Identical upstream texts are shared only where
all listed components carry that same text.

## App icon artwork (separate from code)

Copyright sanguneo. App icon artwork is credited to
[sanguneo](https://github.com/sanguneo), as acknowledged in the project README.
This includes the app-icon derivatives in frontend/public: apple-touch-icon.png,
favicon.ico, favicon-16x16.png, favicon-32x32.png, icon-192.png, icon-512.png, and
icon-maskable-512.png. This artwork is not covered by the project's MIT license.
No redistribution or relicensing permission for this artwork is granted by this
notice; rights must be obtained separately from its copyright holder.

## Go module inventory

These are the third-party modules reached by the server's production package
graph across darwin, linux, and windows on amd64 and arm64 with CGO disabled.
Package inclusion varies by platform. Module-wide license files are reproduced
in full, including their own subcomponent qualifications.

| Module | Version | License / scope | Source |
| --- | --- | --- | --- |
| `github.com/Microsoft/go-winio` | `v0.6.2` | MIT; Windows named pipes | https://github.com/Microsoft/go-winio/tree/v0.6.2 |
| `github.com/dolthub/maphash` | `v0.1.0` | Apache-2.0; includes Go-derived BSD code | https://github.com/dolthub/maphash/tree/v0.1.0 |
| `github.com/klauspost/compress` | `v1.17.5` | BSD-3-Clause for flate; full module license also includes Apache-2.0 and MIT subcomponents | https://github.com/klauspost/compress/tree/v1.17.5 |
| `github.com/lxzan/gws` | `v1.8.8` | Apache-2.0 | https://github.com/lxzan/gws/tree/v1.8.8 |
| `golang.org/x/sys` | `v0.47.0` | BSD-3-Clause + PATENTS; Windows | https://github.com/golang/sys/tree/v0.47.0 |
| `golang.org/x/text` | `v0.41.0` | BSD-3-Clause + PATENTS; Windows | https://github.com/golang/text/tree/v0.41.0 |

### Go module license texts

#### github.com/Microsoft/go-winio v0.6.2

Upstream `LICENSE`:

```text
The MIT License (MIT)

Copyright (c) 2015 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

#### github.com/dolthub/maphash v0.1.0

The source files retain `Copyright 2022 Dolthub, Inc.`. Its runtime.go also
retains `Copyright 2022 The Go Authors. All rights reserved.` and identifies
Go-derived BSD-licensed code; the Go BSD license is reproduced below.

Upstream `LICENSE`:

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

#### github.com/klauspost/compress v1.17.5

The application imports flate, not the other subpackages named in the module
license. The following is the complete upstream LICENSE, without removing its
additional subcomponent notices.

Upstream `LICENSE`:

```text
Copyright (c) 2012 The Go Authors. All rights reserved.
Copyright (c) 2019 Klaus Post. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

------------------

Files: gzhttp/*

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2016-2017 The New York Times Company

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

------------------

Files: s2/cmd/internal/readahead/*

The MIT License (MIT)

Copyright (c) 2015 Klaus Post

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---------------------
Files: snappy/*
Files: internal/snapref/*

Copyright (c) 2011 The Snappy-Go Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

-----------------

Files: s2/cmd/internal/filepathx/*

Copyright 2016 The filepathx Authors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### github.com/lxzan/gws v1.8.8

Upstream `LICENSE`:

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

#### golang.org/x/sys v0.47.0

Upstream `LICENSE`:

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Upstream `PATENTS`:

```text
Additional IP Rights Grant (Patents)

"This implementation" means the copyrightable works distributed by
Google as part of the Go project.

Google hereby grants to You a perpetual, worldwide, non-exclusive,
no-charge, royalty-free, irrevocable (except as stated in this section)
patent license to make, have made, use, offer to sell, sell, import,
transfer and otherwise run, modify and propagate the contents of this
implementation of Go, where such license applies only to those patent
claims, both currently owned or controlled by Google and acquired in
the future, licensable by Google that are necessarily infringed by this
implementation of Go.  This grant does not include claims that would be
infringed only as a consequence of further modification of this
implementation.  If you or your agent or exclusive licensee institute or
order or agree to the institution of patent litigation against any
entity (including a cross-claim or counterclaim in a lawsuit) alleging
that this implementation of Go or any code incorporated within this
implementation of Go constitutes direct or contributory patent
infringement, or inducement of patent infringement, then any patent
rights granted to you under this License for this implementation of Go
shall terminate as of the date such litigation is filed.
```

#### golang.org/x/text v0.41.0

Upstream `LICENSE`:

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Upstream `PATENTS`:

```text
Additional IP Rights Grant (Patents)

"This implementation" means the copyrightable works distributed by
Google as part of the Go project.

Google hereby grants to You a perpetual, worldwide, non-exclusive,
no-charge, royalty-free, irrevocable (except as stated in this section)
patent license to make, have made, use, offer to sell, sell, import,
transfer and otherwise run, modify and propagate the contents of this
implementation of Go, where such license applies only to those patent
claims, both currently owned or controlled by Google and acquired in
the future, licensable by Google that are necessarily infringed by this
implementation of Go.  This grant does not include claims that would be
infringed only as a consequence of further modification of this
implementation.  If you or your agent or exclusive licensee institute or
order or agree to the institution of patent litigation against any
entity (including a cross-claim or counterclaim in a lawsuit) alleging
that this implementation of Go or any code incorporated within this
implementation of Go constitutes direct or contributory patent
infringement, or inducement of patent infringement, then any patent
rights granted to you under this License for this implementation of Go
shall terminate as of the date such litigation is filed.
```

## Go runtime, standard library, and incorporated code

Go runtime and standard-library source baselines: [go1.26.0](https://github.com/golang/go/tree/go1.26.0)
and [go1.27.1](https://github.com/golang/go/tree/go1.27.1). The compiler version for
a particular binary is recorded in its Go build information (`go version -m`).
The common BSD-3-Clause LICENSE and additional patent grant also cover Go's
vendored golang.org/x libraries. These are distinct from the application module
versions above:

| Vendored component | Go 1.26.0 source | Go 1.27.1 source |
| --- | --- | --- |
| `golang.org/x/crypto` | `v0.46.1-0.20251210140736-7dacc380ba00` | `v0.52.1-0.20260526024921-9beb694f9766` |
| `golang.org/x/net` | `v0.47.1-0.20251128220604-7c360367ab7e` | `v0.55.1-0.20260731170536-c1d18010be90` |
| `golang.org/x/sys` | `v0.39.0` | `v0.45.0` |
| `golang.org/x/text` | `v0.32.0` | `v0.37.0` |

Source locations: `src/vendor/modules.txt` and `src/vendor/golang.org/x/` in
the corresponding Go source tag. Additional incorporated-code notices follow.

### Go LICENSE (BSD-3-Clause)

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Go PATENTS

```text
Additional IP Rights Grant (Patents)

"This implementation" means the copyrightable works distributed by
Google as part of the Go project.

Google hereby grants to You a perpetual, worldwide, non-exclusive,
no-charge, royalty-free, irrevocable (except as stated in this section)
patent license to make, have made, use, offer to sell, sell, import,
transfer and otherwise run, modify and propagate the contents of this
implementation of Go, where such license applies only to those patent
claims, both currently owned or controlled by Google and acquired in
the future, licensable by Google that are necessarily infringed by this
implementation of Go.  This grant does not include claims that would be
infringed only as a consequence of further modification of this
implementation.  If you or your agent or exclusive licensee institute or
order or agree to the institution of patent litigation against any
entity (including a cross-claim or counterclaim in a lawsuit) alleging
that this implementation of Go or any code incorporated within this
implementation of Go constitutes direct or contributory patent
infringement, or inducement of patent infringement, then any patent
rights granted to you under this License for this implementation of Go
shall terminate as of the date such litigation is filed.
```

### Inferno-derived amd64 memory copy code (MIT)

Source: `src/runtime/memmove_amd64.s` in Go.

```text
Derived from Inferno's libkern/memmove-386.s (adapted for amd64)
https://bitbucket.org/inferno-os/inferno-os/src/master/libkern/memmove-386.s

        Copyright © 1994-1999 Lucent Technologies Inc. All rights reserved.
        Revisions Copyright © 2000-2007 Vita Nuova Holdings Limited (www.vitanuova.com).  All rights reserved.
        Portions Copyright 2009 The Go Authors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Sun Microsystems math code

Source: notices retained in Go `src/math`, including acosh.go and exp.go.

```text
====================================================
Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.

Developed at SunPro, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
====================================================
```

```text
====================================================
Copyright (C) 2004 by Sun Microsystems, Inc. All rights reserved.

Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
====================================================
```

### Cephes math code

Source: Go `src/math` (including sin.go, atan.go, gamma.go, tan.go, tanh.go).
The following upstream attribution and permission text is retained verbatim
apart from removing Go comment markers.

```text

Cephes Math Library Release 2.8:  June, 2000
Copyright 1984, 1987, 1989, 1992, 2000 by Stephen L. Moshier

The readme file at http://netlib.sandia.gov/cephes/ says:
   Some software in this archive may be from the book _Methods and
Programs for Mathematical Functions_ (Prentice-Hall or Simon & Schuster
International, 1989) or from the Cephes Mathematical Library, a
commercial product. In either event, it is copyrighted by the author.
What you see here may be used freely but it comes with no support or
guarantee.

  The two known misprints in the book are repaired here in the
source listings for the gamma function and the incomplete beta
integral.

  Stephen L. Moshier
  moshier@na-net.ornl.gov
```

### Fiat Cryptography (BSD-1-Clause notices)

The Go standard library incorporates generated Fiat Cryptography code.
Go `src/crypto/internal/fips140/edwards25519/scalar.go` identifies v0.0.9
(commit 23d2dbc) and contains this notice:

```text
    Copyright (c) 2015-2020 The fiat-crypto Authors. All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are
    met:

        1. Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.

    THIS SOFTWARE IS PROVIDED BY the fiat-crypto authors "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
    THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL Berkeley Software Design,
    Inc. BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
    EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
    LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
    NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
    SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

Go 1.27.1 `src/crypto/internal/fips140/nistec/p256_ordinv.go` identifies
v0.1.6-63-g92ee794c2 and contains this additional notice (comment indentation normalized):

```text
     Copyright (c) 2015-2020 the fiat-crypto authors (see the AUTHORS file)
     All rights reserved.

     Redistribution and use in source and binary forms, with or without
     modification, are permitted provided that the following conditions are
     met:

        1. Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.

     THIS SOFTWARE IS PROVIDED BY the fiat-crypto authors "AS IS"
     AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
     THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
     PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL Berkeley Software Design,
     Inc. BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
     EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
     PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
     PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
     LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
     NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
     SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

```

## Frontend dependency inventory

This is the full non-development dependency closure in frontend/package-lock.json,
not a claim that every package's code survives browser resolution and tree-shaking.
It deliberately retains notices for transitive type packages, Node-only paths,
and eliminated modules as well as bundled runtime code. Development-only test and
build tools are not shipped; the build-injected runtime helpers are identified
separately below. Exact npm distribution sources are linked by package and version.

| Package | Version | License | Exact npm source | Upstream source | Text |
| --- | --- | --- | --- | --- | --- |
| `@tanstack/react-virtual` | `3.14.8` | MIT | [tarball](https://registry.npmjs.org/@tanstack/react-virtual/-/react-virtual-3.14.8.tgz) | [repository](https://github.com/TanStack/virtual.git) | [F01](#f01) |
| `@tanstack/virtual-core` | `3.17.6` | MIT | [tarball](https://registry.npmjs.org/@tanstack/virtual-core/-/virtual-core-3.17.6.tgz) | [repository](https://github.com/TanStack/virtual.git) | [F01](#f01) |
| `@types/debug` | `4.1.13` | MIT | [tarball](https://registry.npmjs.org/@types/debug/-/debug-4.1.13.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/estree` | `1.0.9` | MIT | [tarball](https://registry.npmjs.org/@types/estree/-/estree-1.0.9.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/estree-jsx` | `1.0.5` | MIT | [tarball](https://registry.npmjs.org/@types/estree-jsx/-/estree-jsx-1.0.5.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/hast` | `3.0.5` | MIT | [tarball](https://registry.npmjs.org/@types/hast/-/hast-3.0.5.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/katex` | `0.16.8` | MIT | [tarball](https://registry.npmjs.org/@types/katex/-/katex-0.16.8.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/mdast` | `4.0.4` | MIT | [tarball](https://registry.npmjs.org/@types/mdast/-/mdast-4.0.4.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/ms` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/@types/ms/-/ms-2.1.0.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/prop-types` | `15.7.15` | MIT | [tarball](https://registry.npmjs.org/@types/prop-types/-/prop-types-15.7.15.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/react` | `18.3.31` | MIT | [tarball](https://registry.npmjs.org/@types/react/-/react-18.3.31.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@types/unist` | `3.0.3` | MIT | [tarball](https://registry.npmjs.org/@types/unist/-/unist-3.0.3.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `@ungap/structured-clone` | `1.3.3` | ISC | [tarball](https://registry.npmjs.org/@ungap/structured-clone/-/structured-clone-1.3.3.tgz) | [repository](https://github.com/ungap/structured-clone.git) | [F03](#f03) |
| `bail` | `2.0.2` | MIT | [tarball](https://registry.npmjs.org/bail/-/bail-2.0.2.tgz) | [repository](https://github.com/wooorm/bail) | [F04](#f04) |
| `ccount` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/ccount/-/ccount-2.0.1.tgz) | [repository](https://github.com/wooorm/ccount) | [F04](#f04) |
| `character-entities` | `2.0.2` | MIT | [tarball](https://registry.npmjs.org/character-entities/-/character-entities-2.0.2.tgz) | [repository](https://github.com/wooorm/character-entities) | [F04](#f04) |
| `character-entities-html4` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/character-entities-html4/-/character-entities-html4-2.1.0.tgz) | [repository](https://github.com/wooorm/character-entities-html4) | [F04](#f04) |
| `character-entities-legacy` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/character-entities-legacy/-/character-entities-legacy-3.0.0.tgz) | [repository](https://github.com/wooorm/character-entities-legacy) | [F04](#f04) |
| `character-reference-invalid` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/character-reference-invalid/-/character-reference-invalid-2.0.1.tgz) | [repository](https://github.com/wooorm/character-reference-invalid) | [F04](#f04) |
| `comma-separated-tokens` | `2.0.3` | MIT | [tarball](https://registry.npmjs.org/comma-separated-tokens/-/comma-separated-tokens-2.0.3.tgz) | [repository](https://github.com/wooorm/comma-separated-tokens) | [F05](#f05) |
| `commander` | `8.3.0` | MIT | [tarball](https://registry.npmjs.org/commander/-/commander-8.3.0.tgz) | [repository](https://github.com/tj/commander.js.git) | [F06](#f06) |
| `csstype` | `3.2.3` | MIT | [tarball](https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz) | [repository](https://github.com/frenic/csstype) | [F07](#f07) |
| `debug` | `4.4.3` | MIT | [tarball](https://registry.npmjs.org/debug/-/debug-4.4.3.tgz) | [repository](https://github.com/debug-js/debug.git) | [F08](#f08) |
| `decode-named-character-reference` | `1.3.0` | MIT | [tarball](https://registry.npmjs.org/decode-named-character-reference/-/decode-named-character-reference-1.3.0.tgz) | [repository](https://github.com/wooorm/decode-named-character-reference) | [F09](#f09) |
| `dequal` | `2.0.3` | MIT | [tarball](https://registry.npmjs.org/dequal/-/dequal-2.0.3.tgz) | [repository](https://github.com/lukeed/dequal) | [F10](#f10) |
| `devlop` | `1.1.0` | MIT | [tarball](https://registry.npmjs.org/devlop/-/devlop-1.1.0.tgz) | [repository](https://github.com/wooorm/devlop) | [F11](#f11) |
| `escape-string-regexp` | `5.0.0` | MIT | [tarball](https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-5.0.0.tgz) | [repository](https://github.com/sindresorhus/escape-string-regexp) | [F12](#f12) |
| `estree-util-is-identifier-name` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/estree-util-is-identifier-name/-/estree-util-is-identifier-name-3.0.0.tgz) | [repository](https://github.com/syntax-tree/estree-util-is-identifier-name) | [F13](#f13) |
| `extend` | `3.0.2` | MIT | [tarball](https://registry.npmjs.org/extend/-/extend-3.0.2.tgz) | [repository](https://github.com/justmoon/node-extend.git) | [F14](#f14) |
| `hast-util-from-dom` | `5.0.1` | ISC | [tarball](https://registry.npmjs.org/hast-util-from-dom/-/hast-util-from-dom-5.0.1.tgz) | [repository](https://github.com/syntax-tree/hast-util-from-dom) | [F15](#f15) |
| `hast-util-from-html` | `2.0.3` | MIT | [tarball](https://registry.npmjs.org/hast-util-from-html/-/hast-util-from-html-2.0.3.tgz) | [repository](https://github.com/syntax-tree/hast-util-from-html) | [F16](#f16) |
| `hast-util-from-html-isomorphic` | `2.0.0` | MIT | [tarball](https://registry.npmjs.org/hast-util-from-html-isomorphic/-/hast-util-from-html-isomorphic-2.0.0.tgz) | [repository](https://github.com/syntax-tree/hast-util-from-html-isomorphic) | [F17](#f17) |
| `entities` | `6.0.1` | BSD-2-Clause | [tarball](https://registry.npmjs.org/entities/-/entities-6.0.1.tgz) | [repository](https://github.com/fb55/entities.git) | [F18](#f18) |
| `parse5` | `7.3.0` | MIT | [tarball](https://registry.npmjs.org/parse5/-/parse5-7.3.0.tgz) | [repository](https://github.com/inikulin/parse5.git) | [F19](#f19) |
| `hast-util-from-parse5` | `8.0.3` | MIT | [tarball](https://registry.npmjs.org/hast-util-from-parse5/-/hast-util-from-parse5-8.0.3.tgz) | [repository](https://github.com/syntax-tree/hast-util-from-parse5) | [F09](#f09) |
| `hast-util-is-element` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/hast-util-is-element/-/hast-util-is-element-3.0.0.tgz) | [repository](https://github.com/syntax-tree/hast-util-is-element) | [F05](#f05) |
| `hast-util-parse-selector` | `4.0.0` | MIT | [tarball](https://registry.npmjs.org/hast-util-parse-selector/-/hast-util-parse-selector-4.0.0.tgz) | [repository](https://github.com/syntax-tree/hast-util-parse-selector) | [F05](#f05) |
| `hast-util-to-jsx-runtime` | `2.3.6` | MIT | [tarball](https://registry.npmjs.org/hast-util-to-jsx-runtime/-/hast-util-to-jsx-runtime-2.3.6.tgz) | [repository](https://github.com/syntax-tree/hast-util-to-jsx-runtime) | [F09](#f09) |
| `hast-util-to-text` | `4.0.2` | MIT | [tarball](https://registry.npmjs.org/hast-util-to-text/-/hast-util-to-text-4.0.2.tgz) | [repository](https://github.com/syntax-tree/hast-util-to-text) | [F20](#f20) |
| `hast-util-whitespace` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/hast-util-whitespace/-/hast-util-whitespace-3.0.0.tgz) | [repository](https://github.com/syntax-tree/hast-util-whitespace) | [F05](#f05) |
| `hastscript` | `9.0.1` | MIT | [tarball](https://registry.npmjs.org/hastscript/-/hastscript-9.0.1.tgz) | [repository](https://github.com/syntax-tree/hastscript) | [F09](#f09) |
| `html-url-attributes` | `3.0.1` | MIT | [tarball](https://registry.npmjs.org/html-url-attributes/-/html-url-attributes-3.0.1.tgz) | [repository](https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes) | [F21](#f21) |
| `inline-style-parser` | `0.2.7` | MIT | [tarball](https://registry.npmjs.org/inline-style-parser/-/inline-style-parser-0.2.7.tgz) | [repository](https://github.com/remarkablemark/inline-style-parser.git) | [F22](#f22) |
| `is-alphabetical` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/is-alphabetical/-/is-alphabetical-2.0.1.tgz) | [repository](https://github.com/wooorm/is-alphabetical) | [F05](#f05) |
| `is-alphanumerical` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/is-alphanumerical/-/is-alphanumerical-2.0.1.tgz) | [repository](https://github.com/wooorm/is-alphanumerical) | [F05](#f05) |
| `is-decimal` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/is-decimal/-/is-decimal-2.0.1.tgz) | [repository](https://github.com/wooorm/is-decimal) | [F05](#f05) |
| `is-hexadecimal` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/is-hexadecimal/-/is-hexadecimal-2.0.1.tgz) | [repository](https://github.com/wooorm/is-hexadecimal) | [F05](#f05) |
| `is-plain-obj` | `4.1.0` | MIT | [tarball](https://registry.npmjs.org/is-plain-obj/-/is-plain-obj-4.1.0.tgz) | [repository](https://github.com/sindresorhus/is-plain-obj) | [F12](#f12) |
| `js-tokens` | `4.0.0` | MIT | [tarball](https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz) | [repository](https://github.com/lydell/js-tokens) | [F23](#f23) |
| `katex` | `0.16.47` | MIT | [tarball](https://registry.npmjs.org/katex/-/katex-0.16.47.tgz) | [repository](https://github.com/KaTeX/KaTeX.git) | [F24](#f24) |
| `longest-streak` | `3.1.0` | MIT | [tarball](https://registry.npmjs.org/longest-streak/-/longest-streak-3.1.0.tgz) | [repository](https://github.com/wooorm/longest-streak) | [F25](#f25) |
| `loose-envify` | `1.4.0` | MIT | [tarball](https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz) | [repository](https://github.com/zertosh/loose-envify.git) | [F26](#f26) |
| `markdown-table` | `3.0.4` | MIT | [tarball](https://registry.npmjs.org/markdown-table/-/markdown-table-3.0.4.tgz) | [repository](https://github.com/wooorm/markdown-table) | [F09](#f09) |
| `mdast-util-find-and-replace` | `3.0.2` | MIT | [tarball](https://registry.npmjs.org/mdast-util-find-and-replace/-/mdast-util-find-and-replace-3.0.2.tgz) | [repository](https://github.com/syntax-tree/mdast-util-find-and-replace) | [F09](#f09) |
| `mdast-util-from-markdown` | `2.0.3` | MIT | [tarball](https://registry.npmjs.org/mdast-util-from-markdown/-/mdast-util-from-markdown-2.0.3.tgz) | [repository](https://github.com/syntax-tree/mdast-util-from-markdown) | [F09](#f09) |
| `mdast-util-gfm` | `3.1.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm/-/mdast-util-gfm-3.1.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm) | [F09](#f09) |
| `mdast-util-gfm-autolink-literal` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm-autolink-literal/-/mdast-util-gfm-autolink-literal-2.0.1.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm-autolink-literal) | [F13](#f13) |
| `mdast-util-gfm-footnote` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm-footnote/-/mdast-util-gfm-footnote-2.1.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm-footnote) | [F09](#f09) |
| `mdast-util-gfm-strikethrough` | `2.0.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm-strikethrough/-/mdast-util-gfm-strikethrough-2.0.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm-strikethrough) | [F13](#f13) |
| `mdast-util-gfm-table` | `2.0.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm-table/-/mdast-util-gfm-table-2.0.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm-table) | [F13](#f13) |
| `mdast-util-gfm-task-list-item` | `2.0.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-gfm-task-list-item/-/mdast-util-gfm-task-list-item-2.0.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-gfm-task-list-item) | [F13](#f13) |
| `mdast-util-math` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-math/-/mdast-util-math-3.0.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-math) | [F13](#f13) |
| `mdast-util-mdx-expression` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/mdast-util-mdx-expression/-/mdast-util-mdx-expression-2.0.1.tgz) | [repository](https://github.com/syntax-tree/mdast-util-mdx-expression) | [F13](#f13) |
| `mdast-util-mdx-jsx` | `3.2.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-mdx-jsx/-/mdast-util-mdx-jsx-3.2.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-mdx-jsx) | [F13](#f13) |
| `mdast-util-mdxjs-esm` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/mdast-util-mdxjs-esm/-/mdast-util-mdxjs-esm-2.0.1.tgz) | [repository](https://github.com/syntax-tree/mdast-util-mdxjs-esm) | [F13](#f13) |
| `mdast-util-phrasing` | `4.1.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-phrasing/-/mdast-util-phrasing-4.1.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-phrasing) | [F27](#f27) |
| `mdast-util-to-hast` | `13.2.1` | MIT | [tarball](https://registry.npmjs.org/mdast-util-to-hast/-/mdast-util-to-hast-13.2.1.tgz) | [repository](https://github.com/syntax-tree/mdast-util-to-hast) | [F05](#f05) |
| `mdast-util-to-markdown` | `2.1.2` | MIT | [tarball](https://registry.npmjs.org/mdast-util-to-markdown/-/mdast-util-to-markdown-2.1.2.tgz) | [repository](https://github.com/syntax-tree/mdast-util-to-markdown) | [F09](#f09) |
| `mdast-util-to-string` | `4.0.0` | MIT | [tarball](https://registry.npmjs.org/mdast-util-to-string/-/mdast-util-to-string-4.0.0.tgz) | [repository](https://github.com/syntax-tree/mdast-util-to-string) | [F04](#f04) |
| `micromark` | `4.0.2` | MIT | [tarball](https://registry.npmjs.org/micromark/-/micromark-4.0.2.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark) | [F09](#f09) |
| `micromark-core-commonmark` | `2.0.3` | MIT | [tarball](https://registry.npmjs.org/micromark-core-commonmark/-/micromark-core-commonmark-2.0.3.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark) | [F09](#f09) |
| `micromark-extension-gfm` | `3.0.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm/-/micromark-extension-gfm-3.0.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm) | [F13](#f13) |
| `micromark-extension-gfm-autolink-literal` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-autolink-literal/-/micromark-extension-gfm-autolink-literal-2.1.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-autolink-literal) | [F13](#f13) |
| `micromark-extension-gfm-footnote` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-footnote/-/micromark-extension-gfm-footnote-2.1.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-footnote) | [F28](#f28) |
| `micromark-extension-gfm-strikethrough` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-strikethrough/-/micromark-extension-gfm-strikethrough-2.1.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-strikethrough) | [F13](#f13) |
| `micromark-extension-gfm-table` | `2.1.1` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-table/-/micromark-extension-gfm-table-2.1.1.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-table) | [F09](#f09) |
| `micromark-extension-gfm-tagfilter` | `2.0.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-tagfilter/-/micromark-extension-gfm-tagfilter-2.0.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-tagfilter) | [F13](#f13) |
| `micromark-extension-gfm-task-list-item` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-gfm-task-list-item/-/micromark-extension-gfm-task-list-item-2.1.0.tgz) | [repository](https://github.com/micromark/micromark-extension-gfm-task-list-item) | [F13](#f13) |
| `micromark-extension-math` | `3.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-extension-math/-/micromark-extension-math-3.1.0.tgz) | [repository](https://github.com/micromark/micromark-extension-math) | [F13](#f13) |
| `micromark-factory-destination` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-factory-destination/-/micromark-factory-destination-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination) | [F09](#f09) |
| `micromark-factory-label` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-factory-label/-/micromark-factory-label-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label) | [F09](#f09) |
| `micromark-factory-space` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-factory-space/-/micromark-factory-space-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space) | [F09](#f09) |
| `micromark-factory-title` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-factory-title/-/micromark-factory-title-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title) | [F09](#f09) |
| `micromark-factory-whitespace` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-factory-whitespace/-/micromark-factory-whitespace-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace) | [F09](#f09) |
| `micromark-util-character` | `2.1.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-character/-/micromark-util-character-2.1.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-character) | [F09](#f09) |
| `micromark-util-chunked` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-chunked/-/micromark-util-chunked-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked) | [F09](#f09) |
| `micromark-util-classify-character` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-classify-character/-/micromark-util-classify-character-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character) | [F09](#f09) |
| `micromark-util-combine-extensions` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-combine-extensions/-/micromark-util-combine-extensions-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions) | [F09](#f09) |
| `micromark-util-decode-numeric-character-reference` | `2.0.2` | MIT | [tarball](https://registry.npmjs.org/micromark-util-decode-numeric-character-reference/-/micromark-util-decode-numeric-character-reference-2.0.2.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference) | [F09](#f09) |
| `micromark-util-decode-string` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-decode-string/-/micromark-util-decode-string-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string) | [F09](#f09) |
| `micromark-util-encode` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-encode/-/micromark-util-encode-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode) | [F09](#f09) |
| `micromark-util-html-tag-name` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-html-tag-name/-/micromark-util-html-tag-name-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name) | [F09](#f09) |
| `micromark-util-normalize-identifier` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-normalize-identifier/-/micromark-util-normalize-identifier-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier) | [F09](#f09) |
| `micromark-util-resolve-all` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-resolve-all/-/micromark-util-resolve-all-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all) | [F09](#f09) |
| `micromark-util-sanitize-uri` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-sanitize-uri/-/micromark-util-sanitize-uri-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri) | [F09](#f09) |
| `micromark-util-subtokenize` | `2.1.0` | MIT | [tarball](https://registry.npmjs.org/micromark-util-subtokenize/-/micromark-util-subtokenize-2.1.0.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize) | [F09](#f09) |
| `micromark-util-symbol` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/micromark-util-symbol/-/micromark-util-symbol-2.0.1.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol) | [F09](#f09) |
| `micromark-util-types` | `2.0.2` | MIT | [tarball](https://registry.npmjs.org/micromark-util-types/-/micromark-util-types-2.0.2.tgz) | [repository](https://github.com/micromark/micromark/tree/main/packages/micromark-util-types) | [F09](#f09) |
| `ms` | `2.1.3` | MIT | [tarball](https://registry.npmjs.org/ms/-/ms-2.1.3.tgz) | [repository](https://github.com/vercel/ms) | [F29](#f29) |
| `parse-entities` | `4.0.2` | MIT | [tarball](https://registry.npmjs.org/parse-entities/-/parse-entities-4.0.2.tgz) | [repository](https://github.com/wooorm/parse-entities) | [F30](#f30) |
| `@types/unist` | `2.0.11` | MIT | [tarball](https://registry.npmjs.org/@types/unist/-/unist-2.0.11.tgz) | [repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git) | [F02](#f02) |
| `property-information` | `7.2.0` | MIT | [tarball](https://registry.npmjs.org/property-information/-/property-information-7.2.0.tgz) | [repository](https://github.com/wooorm/property-information) | [F30](#f30) |
| `react` | `18.3.1` | MIT | [tarball](https://registry.npmjs.org/react/-/react-18.3.1.tgz) | [repository](https://github.com/facebook/react.git) | [F31](#f31) |
| `react-dom` | `18.3.1` | MIT | [tarball](https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz) | [repository](https://github.com/facebook/react.git) | [F31](#f31) |
| `react-markdown` | `10.1.0` | MIT | [tarball](https://registry.npmjs.org/react-markdown/-/react-markdown-10.1.0.tgz) | [repository](https://github.com/remarkjs/react-markdown) | [F32](#f32) |
| `rehype-katex` | `7.0.1` | MIT | [tarball](https://registry.npmjs.org/rehype-katex/-/rehype-katex-7.0.1.tgz) | [repository](https://github.com/remarkjs/remark-math/tree/main/packages/rehype-katex) | [F33](#f33) |
| `remark-gfm` | `4.0.1` | MIT | [tarball](https://registry.npmjs.org/remark-gfm/-/remark-gfm-4.0.1.tgz) | [repository](https://github.com/remarkjs/remark-gfm) | [F09](#f09) |
| `remark-math` | `6.0.0` | MIT | [tarball](https://registry.npmjs.org/remark-math/-/remark-math-6.0.0.tgz) | [repository](https://github.com/remarkjs/remark-math/tree/main/packages/remark-math) | [F33](#f33) |
| `remark-parse` | `11.0.0` | MIT | [tarball](https://registry.npmjs.org/remark-parse/-/remark-parse-11.0.0.tgz) | [repository](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) | [F34](#f34) |
| `remark-rehype` | `11.1.2` | MIT | [tarball](https://registry.npmjs.org/remark-rehype/-/remark-rehype-11.1.2.tgz) | [repository](https://github.com/remarkjs/remark-rehype) | [F09](#f09) |
| `remark-stringify` | `11.0.0` | MIT | [tarball](https://registry.npmjs.org/remark-stringify/-/remark-stringify-11.0.0.tgz) | [repository](https://github.com/remarkjs/remark/tree/main/packages/remark-stringify) | [F34](#f34) |
| `scheduler` | `0.23.2` | MIT | [tarball](https://registry.npmjs.org/scheduler/-/scheduler-0.23.2.tgz) | [repository](https://github.com/facebook/react.git) | [F31](#f31) |
| `space-separated-tokens` | `2.0.2` | MIT | [tarball](https://registry.npmjs.org/space-separated-tokens/-/space-separated-tokens-2.0.2.tgz) | [repository](https://github.com/wooorm/space-separated-tokens) | [F05](#f05) |
| `stringify-entities` | `4.0.4` | MIT | [tarball](https://registry.npmjs.org/stringify-entities/-/stringify-entities-4.0.4.tgz) | [repository](https://github.com/wooorm/stringify-entities) | [F25](#f25) |
| `style-to-js` | `1.1.21` | MIT | [tarball](https://registry.npmjs.org/style-to-js/-/style-to-js-1.1.21.tgz) | [repository](https://github.com/remarkablemark/style-to-js.git) | [F35](#f35) |
| `style-to-object` | `1.0.14` | MIT | [tarball](https://registry.npmjs.org/style-to-object/-/style-to-object-1.0.14.tgz) | [repository](https://github.com/remarkablemark/style-to-object.git) | [F36](#f36) |
| `trim-lines` | `3.0.1` | MIT | [tarball](https://registry.npmjs.org/trim-lines/-/trim-lines-3.0.1.tgz) | [repository](https://github.com/wooorm/trim-lines) | [F25](#f25) |
| `trough` | `2.2.0` | MIT | [tarball](https://registry.npmjs.org/trough/-/trough-2.2.0.tgz) | [repository](https://github.com/wooorm/trough) | [F37](#f37) |
| `unified` | `11.0.5` | MIT | [tarball](https://registry.npmjs.org/unified/-/unified-11.0.5.tgz) | [repository](https://github.com/unifiedjs/unified) | [F38](#f38) |
| `unist-util-find-after` | `5.0.0` | MIT | [tarball](https://registry.npmjs.org/unist-util-find-after/-/unist-util-find-after-5.0.0.tgz) | [repository](https://github.com/syntax-tree/unist-util-find-after) | [F04](#f04) |
| `unist-util-is` | `6.0.1` | MIT | [tarball](https://registry.npmjs.org/unist-util-is/-/unist-util-is-6.0.1.tgz) | [repository](https://github.com/syntax-tree/unist-util-is) | [F39](#f39) |
| `unist-util-position` | `5.0.0` | MIT | [tarball](https://registry.npmjs.org/unist-util-position/-/unist-util-position-5.0.0.tgz) | [repository](https://github.com/syntax-tree/unist-util-position) | [F04](#f04) |
| `unist-util-remove-position` | `5.0.0` | MIT | [tarball](https://registry.npmjs.org/unist-util-remove-position/-/unist-util-remove-position-5.0.0.tgz) | [repository](https://github.com/syntax-tree/unist-util-remove-position) | [F05](#f05) |
| `unist-util-stringify-position` | `4.0.0` | MIT | [tarball](https://registry.npmjs.org/unist-util-stringify-position/-/unist-util-stringify-position-4.0.0.tgz) | [repository](https://github.com/syntax-tree/unist-util-stringify-position) | [F05](#f05) |
| `unist-util-visit` | `5.1.0` | MIT | [tarball](https://registry.npmjs.org/unist-util-visit/-/unist-util-visit-5.1.0.tgz) | [repository](https://github.com/syntax-tree/unist-util-visit) | [F04](#f04) |
| `unist-util-visit-parents` | `6.0.2` | MIT | [tarball](https://registry.npmjs.org/unist-util-visit-parents/-/unist-util-visit-parents-6.0.2.tgz) | [repository](https://github.com/syntax-tree/unist-util-visit-parents) | [F05](#f05) |
| `vfile` | `6.0.3` | MIT | [tarball](https://registry.npmjs.org/vfile/-/vfile-6.0.3.tgz) | [repository](https://github.com/vfile/vfile) | [F38](#f38) |
| `vfile-location` | `5.0.3` | MIT | [tarball](https://registry.npmjs.org/vfile-location/-/vfile-location-5.0.3.tgz) | [repository](https://github.com/vfile/vfile-location) | [F05](#f05) |
| `vfile-message` | `4.0.3` | MIT | [tarball](https://registry.npmjs.org/vfile-message/-/vfile-message-4.0.3.tgz) | [repository](https://github.com/vfile/vfile-message) | [F09](#f09) |
| `web-namespaces` | `2.0.1` | MIT | [tarball](https://registry.npmjs.org/web-namespaces/-/web-namespaces-2.0.1.tgz) | [repository](https://github.com/wooorm/web-namespaces) | [F05](#f05) |
| `zwitch` | `2.0.4` | MIT | [tarball](https://registry.npmjs.org/zwitch/-/zwitch-2.0.4.tgz) | [repository](https://github.com/wooorm/zwitch) | [F05](#f05) |

### Frontend license texts

The two remark-math monorepo packages omit the root license from their npm
tarballs. Their full root licenses are reproduced from the matching source tags:

- rehype-katex: https://raw.githubusercontent.com/remarkjs/remark-math/rehype-katex%407.0.1/license
- remark-math: https://raw.githubusercontent.com/remarkjs/remark-math/6.0.0/license

#### F01

Applies to: `@tanstack/react-virtual@3.14.8`, `@tanstack/virtual-core@3.17.6`.

```text
MIT License

Copyright (c) 2021-present Tanner Linsley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F02

Applies to: `@types/debug@4.1.13`, `@types/estree@1.0.9`, `@types/estree-jsx@1.0.5`, `@types/hast@3.0.5`, `@types/katex@0.16.8`, `@types/mdast@4.0.4`, `@types/ms@2.1.0`, `@types/prop-types@15.7.15`, `@types/react@18.3.31`, `@types/unist@3.0.3`, `@types/unist@2.0.11`.

```text
    MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

#### F03

Applies to: `@ungap/structured-clone@1.3.3`.

```text
ISC License

Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

#### F04

Applies to: `bail@2.0.2`, `ccount@2.0.1`, `character-entities@2.0.2`, `character-entities-html4@2.1.0`, `character-entities-legacy@3.0.0`, `character-reference-invalid@2.0.1`, `mdast-util-to-string@4.0.0`, `unist-util-find-after@5.0.0`, `unist-util-position@5.0.0`, `unist-util-visit@5.1.0`.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F05

Applies to: `comma-separated-tokens@2.0.3`, `hast-util-is-element@3.0.0`, `hast-util-parse-selector@4.0.0`, `hast-util-whitespace@3.0.0`, `is-alphabetical@2.0.1`, `is-alphanumerical@2.0.1`, `is-decimal@2.0.1`, `is-hexadecimal@2.0.1`, `mdast-util-to-hast@13.2.1`, `space-separated-tokens@2.0.2`, `unist-util-remove-position@5.0.0`, `unist-util-stringify-position@4.0.0`, `unist-util-visit-parents@6.0.2`, `vfile-location@5.0.3`, `web-namespaces@2.0.1`, `zwitch@2.0.4`.

```text
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F06

Applies to: `commander@8.3.0`.

```text
(The MIT License)

Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F07

Applies to: `csstype@3.2.3`.

```text
Copyright (c) 2017-2018 Fredrik Nicol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F08

Applies to: `debug@4.4.3`.

```text
(The MIT License)

Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca>
Copyright (c) 2018-2021 Josh Junon

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the 'Software'), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

#### F09

Applies to: `decode-named-character-reference@1.3.0`, `hast-util-from-parse5@8.0.3`, `hast-util-to-jsx-runtime@2.3.6`, `hastscript@9.0.1`, `markdown-table@3.0.4`, `mdast-util-find-and-replace@3.0.2`, `mdast-util-from-markdown@2.0.3`, `mdast-util-gfm@3.1.0`, `mdast-util-gfm-footnote@2.1.0`, `mdast-util-to-markdown@2.1.2`, `micromark@4.0.2`, `micromark-core-commonmark@2.0.3`, `micromark-extension-gfm-table@2.1.1`, `micromark-factory-destination@2.0.1`, `micromark-factory-label@2.0.1`, `micromark-factory-space@2.0.1`, `micromark-factory-title@2.0.1`, `micromark-factory-whitespace@2.0.1`, `micromark-util-character@2.1.1`, `micromark-util-chunked@2.0.1`, `micromark-util-classify-character@2.0.1`, `micromark-util-combine-extensions@2.0.1`, `micromark-util-decode-numeric-character-reference@2.0.2`, `micromark-util-decode-string@2.0.1`, `micromark-util-encode@2.0.1`, `micromark-util-html-tag-name@2.0.1`, `micromark-util-normalize-identifier@2.0.1`, `micromark-util-resolve-all@2.0.1`, `micromark-util-sanitize-uri@2.0.1`, `micromark-util-subtokenize@2.1.0`, `micromark-util-symbol@2.0.1`, `micromark-util-types@2.0.2`, `remark-gfm@4.0.1`, `remark-rehype@11.1.2`, `vfile-message@4.0.3`.

```text
(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F10

Applies to: `dequal@2.0.3`.

```text
The MIT License (MIT)

Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F11

Applies to: `devlop@1.1.0`.

```text
(The MIT License)

Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F12

Applies to: `escape-string-regexp@5.0.0`, `is-plain-obj@4.1.0`.

```text
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F13

Applies to: `estree-util-is-identifier-name@3.0.0`, `mdast-util-gfm-autolink-literal@2.0.1`, `mdast-util-gfm-strikethrough@2.0.0`, `mdast-util-gfm-table@2.0.0`, `mdast-util-gfm-task-list-item@2.0.0`, `mdast-util-math@3.0.0`, `mdast-util-mdx-expression@2.0.1`, `mdast-util-mdx-jsx@3.2.0`, `mdast-util-mdxjs-esm@2.0.1`, `micromark-extension-gfm@3.0.0`, `micromark-extension-gfm-autolink-literal@2.1.0`, `micromark-extension-gfm-strikethrough@2.1.0`, `micromark-extension-gfm-tagfilter@2.0.0`, `micromark-extension-gfm-task-list-item@2.1.0`, `micromark-extension-math@3.1.0`.

```text
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F14

Applies to: `extend@3.0.2`.

```text
The MIT License (MIT)

Copyright (c) 2014 Stefan Thomas

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

#### F15

Applies to: `hast-util-from-dom@5.0.1`.

```text
(ISC License)

Copyright (c) Keith McKnight <keith@mcknig.ht>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

#### F16

Applies to: `hast-util-from-html@2.0.3`.

```text
(The MIT License)

Copyright (c) 2022 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F17

Applies to: `hast-util-from-html-isomorphic@2.0.0`.

```text
(The MIT License)

Copyright (c) 2023 Remco Haszing <remcohaszing@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F18

Applies to: `entities@6.0.1`.

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

#### F19

Applies to: `parse5@7.3.0`.

```text
Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F20

Applies to: `hast-util-to-text@4.0.2`.

```text
(The MIT License)

Copyright (c) 2019 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F21

Applies to: `html-url-attributes@3.0.1`.

```text
(The MIT License)

Copyright (c) Titus Wormer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F22

Applies to: `inline-style-parser@0.2.7`.

```text
(The MIT License)

Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the 'Software'), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F23

Applies to: `js-tokens@4.0.0`.

```text
The MIT License (MIT)

Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F24

Applies to: `katex@0.16.47`.

```text
The MIT License (MIT)

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F25

Applies to: `longest-streak@3.1.0`, `stringify-entities@4.0.4`, `trim-lines@3.0.1`.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F26

Applies to: `loose-envify@1.4.0`.

```text
The MIT License (MIT)

Copyright (c) 2015 Andres Suarez <zertosh@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F27

Applies to: `mdast-util-phrasing@4.1.0`.

```text
(The MIT License)

Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
Copyright (c) 2017 Victor Felder <victor@draft.li>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F28

Applies to: `micromark-extension-gfm-footnote@2.1.0`.

```text
(The MIT License)

Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F29

Applies to: `ms@2.1.3`.

```text
The MIT License (MIT)

Copyright (c) 2020 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F30

Applies to: `parse-entities@4.0.2`, `property-information@7.2.0`.

```text
(The MIT License)

Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F31

Applies to: `react@18.3.1`, `react-dom@18.3.1`, `scheduler@0.23.2`.

```text
MIT License

Copyright (c) Facebook, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F32

Applies to: `react-markdown@10.1.0`.

```text
The MIT License (MIT)

Copyright (c) Espen Hovlandsdal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F33

Applies to: `rehype-katex@7.0.1`, `remark-math@6.0.0`.

```text
(The MIT License)

Copyright (c) 2017 Junyoung Choi <fluke8259@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### F34

Applies to: `remark-parse@11.0.0`, `remark-stringify@11.0.0`.

```text
(The MIT License)

Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F35

Applies to: `style-to-js@1.1.21`.

```text
The MIT License (MIT)

Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F36

Applies to: `style-to-object@1.0.14`.

```text
The MIT License (MIT)

Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

#### F37

Applies to: `trough@2.2.0`.

```text
(The MIT License)

Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F38

Applies to: `unified@11.0.5`, `vfile@6.0.3`.

```text
(The MIT License)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

#### F39

Applies to: `unist-util-is@6.0.1`.

```text
(The MIT license)

Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Runtime helpers injected by the frontend build

Vite 6.4.3 injects its module-preload helper. Its bundled Rollup CommonJS plugin
also emits interop helpers. These are runtime snippets, not a distribution of the
Vite development server or its entire tool dependency tree. Source:
https://github.com/vitejs/vite/tree/v6.4.3/packages/vite and the core / Rollup plugin
sections of `vite@6.4.3/LICENSE.md`. The Rollup helper's source revision here is
the copy bundled in Vite 6.4.3, not an independently installed plugin version.

### Vite core (MIT)

```text
# Vite core license
Vite is released under the MIT license:

MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

### RollupJS plugin contributors (MIT)

```text
License: MIT
By: Johannes Stein
Repository: rollup/plugins

License: MIT
By: Rich Harris
Repository: rollup/plugins

License: MIT
By: LarsDenBakker
Repository: rollup/plugins

License: MIT
By: Rich Harris
Repository: rollup/plugins

The MIT License (MIT)

Copyright (c) 2019 RollupJS Plugin Contributors (https://github.com/rollup/plugins/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```

## KaTeX fonts (SIL Open Font License 1.1)

The KaTeX JavaScript license does not replace the font license. The 20 font
faces shipped by katex 0.16.47 (TTF, WOFF, and WOFF2) identify OFL-1.1 in their
font metadata. Source: https://github.com/KaTeX/KaTeX/tree/v0.16.47/fonts and
`katex@0.16.47/dist/fonts`. Bundling changes asset filenames, not font bytes or
internal font names; one small WOFF2 is embedded as a CSS data URI.

Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)
Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>)

Reserved Font Names: KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main,
KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, KaTeX_Size2, KaTeX_Size3,
KaTeX_Size4, KaTeX_Typewriter.

Font faces (each supplied in TTF, WOFF, WOFF2):

- KaTeX_AMS-Regular
- KaTeX_Caligraphic-Bold
- KaTeX_Caligraphic-Regular
- KaTeX_Fraktur-Bold
- KaTeX_Fraktur-Regular
- KaTeX_Main-Bold
- KaTeX_Main-BoldItalic
- KaTeX_Main-Italic
- KaTeX_Main-Regular
- KaTeX_Math-BoldItalic
- KaTeX_Math-Italic
- KaTeX_SansSerif-Bold
- KaTeX_SansSerif-Italic
- KaTeX_SansSerif-Regular
- KaTeX_Script-Regular
- KaTeX_Size1-Regular
- KaTeX_Size2-Regular
- KaTeX_Size3-Regular
- KaTeX_Size4-Regular
- KaTeX_Typewriter-Regular

The font metadata specifies SIL Open Font License Version 1.1 and links to
http://scripts.sil.org/OFL. The complete standard license text is reproduced
below from https://github.com/spdx/license-list-data/blob/v3.27.0/text/OFL-1.1.txt.
The applicable copyright holders and Reserved Font Names are stated above.

```text
SIL OPEN FONT LICENSE

Version 1.1 - 26 February 2007

PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS

"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting — in part or in whole — any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION

This license becomes null and void if any of the above conditions are not met.

DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
```

## UI SVG drawings: Lucide and Feather

The adapted SVG drawings in frontend/src/components/icons.tsx include Lucide and
Feather geometry, distinct from sanguneo's app icon artwork. Upstream reference
revisions: [Lucide 0.468.0](https://github.com/lucide-icons/lucide/tree/0.468.0)
and [Feather v4.29.2](https://github.com/feathericons/feather/tree/v4.29.2).
These identify compared source drawings and license texts, not installed npm
packages or a known original copy date. For example, IconFolderOpen matches
Lucide's folder-open.svg path, and IconSettings uses Feather's settings.svg
geometry. The application adapts the drawings into React components and changes
some path representations. Both upstream license texts are retained below.

### Lucide (ISC)

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Feather (MIT)

```text
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
