import { describe, expect, it } from 'vitest';
import { addGradleDependency, addMavenDependency } from '../dependency-editors.js';

describe('Maven dependency editor', () => {
  it('adds to an existing dependencies block without reformatting it', () => {
    const input = '<project>\n  <dependencies>\n  </dependencies>\n</project>\n';
    const result = addMavenDependency(input, 'org.junit.jupiter:junit-jupiter', '5.12.2');
    expect(result.changed).toBe(true);
    expect(result.text).toBe(
      '<project>\n  <dependencies>\n' +
      '    <dependency>\n      <groupId>org.junit.jupiter</groupId>\n' +
      '      <artifactId>junit-jupiter</artifactId>\n      <version>5.12.2</version>\n' +
      '    </dependency>\n  </dependencies>\n</project>\n',
    );
    expect(addMavenDependency(result.text, 'org.junit.jupiter:junit-jupiter', '5.12.2')).toEqual({
      text: result.text,
      changed: false,
    });
  });

  it('creates a dependencies section when absent', () => {
    const result = addMavenDependency('<project>\r\n</project>\r\n', 'com.google.guava:guava', '33.4.8-jre');
    expect(result.text).toContain('\r\n  <dependencies>\r\n');
    expect(result.text).toContain('<artifactId>guava</artifactId>');
  });

  it('updates the version of an existing dependency in place', () => {
    const input = '<project>\n  <dependencies>\n    <dependency>\n' +
      '      <groupId>com.google.guava</groupId>\n      <artifactId>guava</artifactId>\n' +
      '      <version>32.0.0-jre</version>\n    </dependency>\n  </dependencies>\n</project>\n';
    const result = addMavenDependency(input, 'com.google.guava:guava', '33.4.8-jre');
    expect(result.changed).toBe(true);
    expect(result.text).toBe(input.replace('32.0.0-jre', '33.4.8-jre'));
    expect(addMavenDependency(result.text, 'com.google.guava:guava', '33.4.8-jre').changed).toBe(false);
  });

  it('adds a version to an existing versionless dependency', () => {
    const input = '<project>\n  <dependencies>\n    <dependency>\n' +
      '      <groupId>a</groupId>\n      <artifactId>b</artifactId>\n' +
      '    </dependency>\n  </dependencies>\n</project>\n';
    const result = addMavenDependency(input, 'a:b', '2.0.0');
    expect(result.changed).toBe(true);
    expect(result.text).toContain('      <artifactId>b</artifactId>\n      <version>2.0.0</version>');
  });

  it('does not combine groupId and artifactId from different dependency elements', () => {
    const input = '<project>\n  <dependencies>\n' +
      '    <dependency><groupId>a</groupId><artifactId>x</artifactId></dependency>\n' +
      '    <dependency><groupId>b</groupId><artifactId>y</artifactId></dependency>\n' +
      '  </dependencies>\n</project>\n';
    const result = addMavenDependency(input, 'a:y', '1.0.0');
    expect(result.changed).toBe(true);
    expect(result.text).toContain('<groupId>a</groupId>\n      <artifactId>y</artifactId>');
  });

  it('adds safely when the dependencies tags are inline', () => {
    const result = addMavenDependency('<project><dependencies></dependencies></project>', 'a:b', '1');
    expect(result.text).toMatch(/^<project><dependencies>\n\s+<dependency>/);
    expect(result.text).toContain('</dependency>\n</dependencies></project>');
  });

  it('does not treat dependencyManagement as the project dependency block', () => {
    const input = '<project>\n  <dependencyManagement><dependencies>\n' +
      '    <dependency><groupId>a</groupId><artifactId>x</artifactId></dependency>\n' +
      '  </dependencies></dependencyManagement>\n</project>\n';
    const result = addMavenDependency(input, 'a:x', '1.0.0');
    expect(result.changed).toBe(true);
    expect(result.text.match(/<dependencies>/g)).toHaveLength(2);
  });
});

describe('Gradle dependency editor', () => {
  it('adds Groovy syntax to an existing block and is idempotent', () => {
    const input = 'plugins { id \'java\' }\ndependencies {}\n';
    const result = addGradleDependency(input, 'com.google.guava:guava', '33.4.8-jre', false);
    expect(result.text).toContain("dependencies {\n    implementation 'com.google.guava:guava:33.4.8-jre'\n}");
    expect(addGradleDependency(result.text, 'com.google.guava:guava', '33.4.8-jre', false).changed).toBe(false);
  });

  it('appends a Kotlin dependencies block when absent', () => {
    const result = addGradleDependency('plugins { java }\n', 'org.slf4j:slf4j-api', '2.0.17', true);
    expect(result.text).toContain('implementation("org.slf4j:slf4j-api:2.0.17")');
  });

  it('ignores buildscript dependencies and creates a project-level block', () => {
    const input = "buildscript {\n  dependencies { classpath 'com.example:plugin:1.0' }\n}\n";
    const result = addGradleDependency(input, 'org.slf4j:slf4j-api', '2.0.17', false);
    expect(result.text).toContain("}\ndependencies {\n    implementation 'org.slf4j:slf4j-api:2.0.17'");
  });

  it('is idempotent by module even when the requested version differs', () => {
    const input = "dependencies {\n  implementation 'org.slf4j:slf4j-api:2.0.16'\n}\n";
    expect(addGradleDependency(input, 'org.slf4j:slf4j-api', '2.0.17', false)).toEqual({ text: input, changed: false });
  });
});
